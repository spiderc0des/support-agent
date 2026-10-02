import "server-only";
import { cookies } from "next/headers";
import { z } from "zod";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { isValidTimeZone } from "@relaypay/shared/slots";

/**
 * "Know me": who is about to call, captured before the call starts.
 *
 * Customers sign in with their account email and customer ID (both must
 * match one account); that counts as verification, the same bar the agent
 * applies on a call. Guests give a name and an email. Either way the call
 * starts with the identity attached, so the agent addresses them by name and
 * never asks them to spell a name or an email.
 *
 * The session id is the bearer credential: kept in an httpOnly cookie, passed
 * to Vapi only as call metadata, and never readable through the database API.
 */
export const CALLER_COOKIE = "rp_caller";
const TTL_HOURS = 12;

export const KnowMeRequest = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("customer"),
    email: z.string().trim().email("Enter the email on your RelayPay account.").max(200),
    customer_id: z.string().trim().min(3, "Enter your customer ID, e.g. CUS-1001.").max(40),
    timezone: z.string().max(64).optional(),
  }),
  z.object({
    kind: z.literal("guest"),
    name: z.string().trim().min(1, "Enter your name.").max(120),
    email: z.string().trim().email("Enter a valid email address.").max(200),
    company_name: z.string().trim().max(200).optional(),
    timezone: z.string().max(64).optional(),
  }),
]);
export type KnowMeRequest = z.infer<typeof KnowMeRequest>;

export type CallerSession = {
  id: string;
  kind: "customer" | "guest";
  customer_id: string | null;
  name: string;
  email: string;
  timezone: string | null;
  company_name: string | null;
};

export class KnowMeError extends Error {}

const normaliseCustomerId = (raw: string) => {
  const digits = raw.replace(/\D/g, "");
  return digits ? `CUS-${digits}` : raw.toUpperCase();
};

export async function createCallerSession(req: KnowMeRequest): Promise<CallerSession> {
  const db = supabaseAdmin();
  const timezone = isValidTimeZone(req.timezone) ? req.timezone : null;
  let row: { kind: "customer" | "guest"; customer_id: string | null; name: string; email: string; company_name: string | null };

  if (req.kind === "customer") {
    const { data: customer } = await db
      .from("customers")
      .select("customer_id, company_name, contact_name, contact_email")
      .eq("customer_id", normaliseCustomerId(req.customer_id))
      .maybeSingle();
    // One message for every failure: the form must not reveal which customer IDs exist.
    if (!customer || !customer.contact_email || customer.contact_email.toLowerCase() !== req.email.toLowerCase()) {
      throw new KnowMeError("That email and customer ID don't match an account. Check both, or continue as a guest.");
    }
    row = {
      kind: "customer",
      customer_id: customer.customer_id,
      name: customer.contact_name?.trim() || customer.company_name,
      email: customer.contact_email,
      company_name: customer.company_name,
    };
  } else {
    row = { kind: "guest", customer_id: null, name: req.name.trim(), email: req.email.trim().toLowerCase(), company_name: req.company_name?.trim() || null };
  }

  const { data, error } = await db
    .from("caller_sessions")
    .insert({
      kind: row.kind,
      customer_id: row.customer_id,
      name: row.name,
      email: row.email,
      // A customer's company comes from their account; only a guest's is stored as given.
      company_name: row.kind === "guest" ? row.company_name : null,
      timezone,
      expires_at: new Date(Date.now() + TTL_HOURS * 3_600_000).toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`caller session: ${error?.message ?? "no row"}`);
  return { id: data.id as string, ...row, timezone };
}

export async function callerSessionById(id: string | null | undefined): Promise<CallerSession | null> {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await supabaseAdmin()
    .from("caller_sessions")
    .select("id, kind, customer_id, name, email, timezone, expires_at, company_name, customers(company_name)")
    .eq("id", id)
    .maybeSingle();
  if (!data || new Date(data.expires_at as string) < new Date()) return null;
  const company = (data.customers as unknown as { company_name: string } | null)?.company_name ?? (data.company_name as string | null) ?? null;
  return {
    id: data.id as string,
    kind: data.kind as "customer" | "guest",
    customer_id: (data.customer_id as string | null) ?? null,
    name: data.name as string,
    email: data.email as string,
    timezone: (data.timezone as string | null) ?? null,
    company_name: company,
  };
}

export async function currentCaller(): Promise<CallerSession | null> {
  return callerSessionById((await cookies()).get(CALLER_COOKIE)?.value);
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TTL_HOURS * 3600,
  };
}

/** Link a session to the Vapi call it started, so the call's conversation picks up the identity. */
export async function attachSessionToCall(sessionId: string, vapiCallId: string) {
  const db = supabaseAdmin();
  await db.from("caller_sessions").update({ vapi_call_id: vapiCallId }).eq("id", sessionId);
  // If the conversation already exists (the first utterance won the race), fill it in now.
  const session = await callerSessionById(sessionId);
  if (!session) return;
  await db
    .from("conversations")
    .update(conversationCallerFields(session))
    .eq("vapi_call_id", vapiCallId)
    .is("caller_session_id", null);
}

/** The conversation columns a caller session fills in. A customer sign-in verifies the caller. */
export function conversationCallerFields(s: CallerSession) {
  return {
    caller_session_id: s.id,
    caller_name: s.name,
    caller_email: s.email,
    caller_timezone: s.timezone,
    ...(s.kind === "customer" && s.customer_id ? { customer_id: s.customer_id, verified_at: new Date().toISOString() } : {}),
  };
}

/** The session for a Vapi call: attached by the page, or carried in the call's metadata. */
export async function callerSessionForCall(vapiCallId: string, metadataSessionId: string | null): Promise<CallerSession | null> {
  const { data } = await supabaseAdmin()
    .from("caller_sessions")
    .select("id")
    .eq("vapi_call_id", vapiCallId)
    .gt("expires_at", new Date().toISOString())
    .limit(1)
    .maybeSingle();
  return callerSessionById((data?.id as string | undefined) ?? metadataSessionId);
}
