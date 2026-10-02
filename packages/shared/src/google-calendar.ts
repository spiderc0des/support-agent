/**
 * The few Google Calendar calls the callback booking needs, over plain HTTPS.
 *
 * Each support agent connects their own calendar from their profile page
 * (OAuth, offline access). The web app stores the refresh token; the MCP
 * server uses it at booking time to read free/busy and to create the event.
 *
 * Environment (both services):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  a Google Cloud OAuth client (Web application)
 *   APP_URL                                 the redirect is ${APP_URL}/api/google/callback
 */

export const CALENDAR_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
];

export type GoogleEnv = Record<string, string | undefined>;

export function calendarConfigured(env: GoogleEnv = process.env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function redirectUri(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/google/callback`;
}

export function authorizationUrl(opts: { origin: string; state: string; loginHint?: string }, env: GoogleEnv = process.env): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri(opts.origin));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", CALENDAR_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  // consent: Google only returns a refresh token on a consent screen.
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", opts.state);
  if (opts.loginHint) u.searchParams.set("login_hint", opts.loginHint);
  return u.toString();
}

export class GoogleError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  if (!res.ok) throw new GoogleError(`Google ${res.status}: ${text.slice(0, 300)}`, res.status);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function exchangeCode(code: string, origin: string, env: GoogleEnv = process.env) {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
    redirect_uri: redirectUri(origin),
    grant_type: "authorization_code",
  });
  const t = await call<{ access_token: string; refresh_token?: string; id_token?: string; scope?: string }>("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  // The id_token came straight from Google over TLS in this exchange, so its
  // payload can be read without verifying the signature.
  let email: string | null = null;
  if (t.id_token) {
    try {
      email = JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString("utf8")).email ?? null;
    } catch {
      email = null;
    }
  }
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, email, scope: t.scope ?? "" };
}

export async function accessToken(refreshToken: string, env: GoogleEnv = process.env): Promise<string> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
    grant_type: "refresh_token",
  });
  const t = await call<{ access_token: string }>("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return t.access_token;
}

export async function revoke(token: string): Promise<void> {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST", signal: AbortSignal.timeout(5000) }).catch(() => {});
}

/** Busy intervals on the primary calendar between two instants. */
export async function busyTimes(token: string, timeMin: Date, timeMax: Date): Promise<{ start: Date; end: Date }[]> {
  const r = await call<{ calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>(
    "https://www.googleapis.com/calendar/v3/freeBusy",
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: [{ id: "primary" }] }),
    },
  );
  const cal = r.calendars?.primary;
  if (cal?.errors?.length) throw new GoogleError(`freeBusy: ${JSON.stringify(cal.errors).slice(0, 200)}`, 502);
  return (cal?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

export type NewEvent = {
  summary: string;
  description: string;
  start: Date;
  end: Date;
  timezone: string;
  attendees: { email: string; displayName?: string }[];
};

/**
 * Create the callback on the agent's calendar, with the caller invited and a
 * Google Meet link: a web caller has no phone number on record, so the
 * callback happens on the link in their invite.
 */
export async function createEvent(token: string, ev: NewEvent): Promise<{ id: string; htmlLink: string | null; meetLink: string | null }> {
  const r = await call<{ id: string; htmlLink?: string; hangoutLink?: string }>(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1",
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        summary: ev.summary,
        description: ev.description,
        start: { dateTime: ev.start.toISOString(), timeZone: ev.timezone },
        end: { dateTime: ev.end.toISOString(), timeZone: ev.timezone },
        attendees: ev.attendees,
        reminders: { useDefault: true },
        conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
      }),
    },
  );
  return { id: r.id, htmlLink: r.htmlLink ?? null, meetLink: r.hangoutLink ?? null };
}

export async function deleteEvent(token: string, eventId: string): Promise<void> {
  try {
    await call(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (err) {
    if (err instanceof GoogleError && (err.status === 404 || err.status === 410)) return; // already gone
    throw err;
  }
}
