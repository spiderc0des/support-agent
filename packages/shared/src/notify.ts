/**
 * Emailing the support team when something needs a person.
 *
 * Sent through Brevo's HTTPS API, not SMTP: Railway blocks outbound SMTP on
 * its free tier (week 5 hit exactly this). One email per recipient, so
 * nobody sees the rest of the team's addresses.
 *
 * Callers fire and forget: an email must never delay a live call, and a mail
 * outage must never break one. Every attempt is recorded (notifications
 * table), including skipped and failed ones, with the reason.
 *
 * Environment:
 *   BREVO_API_KEY    Brevo → SMTP & API → API keys
 *   MAIL_FROM        a sender address verified in Brevo
 *   MAIL_FROM_NAME   optional display name (default "RelayPay Support")
 *   APP_URL          public origin, for the links in the email
 *   NOTIFY_CHANNELS  optional, comma-separated (default "web_voice,phone"):
 *                    eval runs and test channels never email the team
 */

export type StaffEvent =
  | {
      kind: "ticket_created";
      ticketId: string;
      conversationId: string;
      channel: string;
      category: string;
      priority: string;
      summary: string;
      customerId: string | null;
    }
  | {
      kind: "escalation_created";
      ticketId: string;
      escalationId: string;
      conversationId: string;
      channel: string;
      category: string;
      priority: string;
      reason: string;
      callerName: string;
      callerEmail: string;
      contactMatchesRecord: boolean | null;
      preferredTime: string | null;
      customerId: string | null;
    }
  | {
      kind: "agent_error";
      ticketId: string;
      conversationId: string;
      channel: string;
      reason: string;
    };

export type Recipient = { email: string; name: string | null };

export type NotificationRow = {
  kind: StaffEvent["kind"];
  ticket_id: string;
  escalation_id: string | null;
  conversation_id: string;
  subject: string;
  recipients: string[];
  status: "sent" | "partial" | "failed" | "skipped";
  detail: string | null;
};

export type NotifyDeps = {
  recipients: () => Promise<Recipient[]>;
  record: (row: NotificationRow) => Promise<void>;
  /** Injected in tests; defaults to Brevo. */
  send?: (to: Recipient, email: BuiltEmail) => Promise<{ ok: true } | { ok: false; reason: string }>;
  env?: Record<string, string | undefined>;
};

export type BuiltEmail = { subject: string; html: string; text: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildStaffEmail(ev: StaffEvent, appUrl: string): BuiltEmail {
  const base = appUrl.replace(/\/$/, "");
  const ticketUrl = `${base}/review/tickets/${ev.ticketId}`;
  const callUrl = `${base}/review/conversations/${ev.conversationId}`;
  const via = ev.channel === "phone" ? "a phone call" : ev.channel === "web_voice" ? "a web voice call" : `the ${ev.channel} channel`;

  let subject: string;
  let lead: string;
  let rows: [string, string][];
  if (ev.kind === "escalation_created") {
    subject = `Escalation ${ev.escalationId}: ${ev.category}, ${ev.priority} priority`;
    lead = `A caller needs a specialist. The agent escalated this during ${via}.`;
    rows = [
      ["Why", ev.reason],
      ["Caller", `${ev.callerName} · ${ev.callerEmail}${ev.contactMatchesRecord === false ? " (not the email on file)" : ev.contactMatchesRecord ? " (matches the account)" : ""}`],
      ["Callback", ev.preferredTime ? `requested: ${ev.preferredTime}` : "not requested"],
      ["Account", ev.customerId ?? "not identified"],
      ["Case", `${ev.ticketId} + ${ev.escalationId}`],
    ];
  } else if (ev.kind === "ticket_created") {
    subject = `Ticket ${ev.ticketId}: ${ev.category}, ${ev.priority} priority`;
    lead = `The agent opened a ticket for the support team during ${via}.`;
    rows = [
      ["Summary", ev.summary],
      ["Account", ev.customerId ?? "not identified"],
    ];
  } else {
    subject = `Agent couldn't finish a call (${ev.ticketId})`;
    lead = `The support agent failed during ${via}. The caller heard a fallback reply, and this ticket was opened so a person can follow up.`;
    rows = [["What failed", ev.reason]];
  }

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b2430;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border:1px solid #dde2e8;border-radius:10px;" cellpadding="0" cellspacing="0"><tr><td style="padding:24px 28px;">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#5b6675;">RelayPay Support</p>
<h1 style="margin:0 0 12px;font-size:19px;line-height:1.3;color:#17365d;">${esc(subject)}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.5;">${esc(lead)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.5;">
${rows.map(([k, v]) => `<tr><td style="padding:3px 16px 3px 0;color:#5b6675;vertical-align:top;white-space:nowrap;">${esc(k)}</td><td style="padding:3px 0;">${esc(v)}</td></tr>`).join("\n")}
</table>
<p style="margin:22px 0 0;"><a href="${esc(ticketUrl)}" style="display:inline-block;padding:10px 18px;background:#17365d;color:#ffffff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">Open the case</a>
&nbsp; <a href="${esc(callUrl)}" style="font-size:14px;color:#1f6f80;">View the call</a></p>
</td></tr></table>
<p style="margin:16px 0 0;font-size:12px;color:#5b6675;">You receive this because you're on the RelayPay support team.</p>
</td></tr></table></body></html>`;

  const text = [subject, "", lead, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", `Open the case: ${ticketUrl}`, `View the call: ${callUrl}`].join("\n");
  return { subject, html, text };
}

/** One email through Brevo's HTTPS API. Never throws. */
export async function sendViaBrevo(to: Recipient, email: BuiltEmail, env: Record<string, string | undefined> = process.env) {
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY!, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME || "RelayPay Support" },
        to: [{ email: to.email, ...(to.name ? { name: to.name } : {}) }],
        subject: email.subject,
        htmlContent: email.html,
        textContent: email.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true as const };
    // Brevo says why in the body: an unverified sender, a bad key, a quota.
    return { ok: false as const, reason: `Brevo ${res.status}: ${(await res.text()).slice(0, 300)}` };
  } catch (err) {
    return { ok: false as const, reason: `Brevo request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Email every support agent and admin about one event, and record what happened. Never throws. */
export async function notifyStaff(ev: StaffEvent, deps: NotifyDeps): Promise<NotificationRow["status"]> {
  const env = deps.env ?? process.env;
  const channels = (env.NOTIFY_CHANNELS ?? "web_voice,phone").split(",").map((c) => c.trim()).filter(Boolean);
  if (!channels.includes(ev.channel)) return "skipped"; // eval runs and test channels: not recorded, not sent

  const appUrl = env.APP_URL || env.NEXT_PUBLIC_APP_URL || "";
  const email = buildStaffEmail(ev, appUrl);
  const base = {
    kind: ev.kind,
    ticket_id: ev.ticketId,
    escalation_id: ev.kind === "escalation_created" ? ev.escalationId : null,
    conversation_id: ev.conversationId,
    subject: email.subject,
  };

  try {
    const recipients = (await deps.recipients()).filter((r) => r.email);
    const record = (status: NotificationRow["status"], detail: string | null) =>
      deps.record({ ...base, recipients: recipients.map((r) => r.email), status, detail });

    if (!recipients.length) {
      await record("skipped", "No support agents or admins to email");
      return "skipped";
    }
    const send = deps.send ?? ((to: Recipient, e: BuiltEmail) => sendViaBrevo(to, e, env));
    if (!deps.send && (!env.BREVO_API_KEY || !env.MAIL_FROM)) {
      await record("skipped", "Email is off: set BREVO_API_KEY and MAIL_FROM");
      return "skipped";
    }

    const results = await Promise.all(recipients.map((r) => send(r, email)));
    const failures = results.flatMap((r, i) => (r.ok ? [] : [`${recipients[i].email}: ${r.reason}`]));
    const status = failures.length === 0 ? "sent" : failures.length === results.length ? "failed" : "partial";
    await record(status, failures.length ? failures.join("; ").slice(0, 1000) : null);
    if (failures.length) console.error(`[notify] ${email.subject}: ${failures.join("; ")}`);
    return status;
  } catch (err) {
    console.error("[notify] could not notify the team:", err instanceof Error ? err.message : err);
    return "failed";
  }
}

export function emailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.BREVO_API_KEY && env.MAIL_FROM);
}

/** The invitation to join the support console. */
export function buildInviteEmail(opts: { name: string; role: "admin" | "support_agent"; link: string; invitedBy: string; expiresDays: number }): BuiltEmail {
  const role = opts.role === "admin" ? "an admin" : "a support agent";
  const subject = "You're invited to the RelayPay support console";
  const lead = `${opts.invitedBy} has invited you to join the RelayPay support team as ${role}.`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b2430;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border:1px solid #dde2e8;border-radius:10px;" cellpadding="0" cellspacing="0"><tr><td style="padding:24px 28px;">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#5b6675;">RelayPay Support</p>
<h1 style="margin:0 0 12px;font-size:19px;line-height:1.3;color:#17365d;">Hi ${esc(opts.name)}, you're invited</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.5;">${esc(lead)} You'll work tickets, escalations and callbacks from the console.</p>
<p style="margin:22px 0 0;"><a href="${esc(opts.link)}" style="display:inline-block;padding:10px 18px;background:#17365d;color:#ffffff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">Accept the invite</a></p>
<p style="margin:18px 0 0;font-size:13px;color:#5b6675;">This link works for ${opts.expiresDays} days. After that, sign in at the console with this email address, or ask an admin to resend the invite.</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = [subject, "", lead, "", `Accept the invite: ${opts.link}`, "", `This link works for ${opts.expiresDays} days.`].join("\n");
  return { subject, html, text };
}
