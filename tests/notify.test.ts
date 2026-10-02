/** The team email: right people, right content, and an honest record of what happened. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStaffEmail, notifyStaff, type NotificationRow, type StaffEvent } from "../packages/shared/src/notify.ts";

const escalation: StaffEvent = {
  kind: "escalation_created", ticketId: "TCK-1003", escalationId: "ESC-102", conversationId: "c984150c-0000-0000-0000-000000000000",
  channel: "web_voice", category: "account", priority: "high", reason: "Account locked <script>", callerName: "Abdul",
  callerEmail: "abdul@example.com", contactMatchesRecord: false, preferredTime: "3 PM", customerId: null,
};

test("the escalation email says what's needed and links to the case", () => {
  const e = buildStaffEmail(escalation, "https://relaypay-support.up.railway.app/");
  assert.equal(e.subject, "Escalation ESC-102: account, high priority");
  assert.match(e.html, /https:\/\/relaypay-support\.up\.railway\.app\/review\/tickets\/TCK-1003/);
  assert.match(e.text, /Callback: requested: 3 PM/);
  assert.match(e.text, /not the email on file/);
  assert.doesNotMatch(e.html, /<script>/, "caller-supplied text is escaped");
});

test("each team member gets their own email, and partial failures are recorded", async () => {
  const sent: string[] = [];
  const rows: NotificationRow[] = [];
  const status = await notifyStaff(escalation, {
    recipients: async () => [{ email: "a@x.test", name: "A" }, { email: "b@x.test", name: null }],
    record: async (r) => void rows.push(r),
    send: async (to) => (sent.push(to.email), to.email === "b@x.test" ? { ok: false, reason: "Brevo 401" } : { ok: true }),
    env: { APP_URL: "https://x.test" },
  });
  assert.equal(status, "partial");
  assert.deepEqual(sent, ["a@x.test", "b@x.test"]);
  assert.equal(rows[0].status, "partial");
  assert.match(rows[0].detail ?? "", /b@x\.test: Brevo 401/);
});

test("eval and test channels never email and leave no record", async () => {
  const rows: NotificationRow[] = [];
  const status = await notifyStaff({ ...escalation, channel: "eval" }, {
    recipients: async () => [{ email: "a@x.test", name: null }],
    record: async (r) => void rows.push(r),
    send: async () => ({ ok: true }),
    env: {},
  });
  assert.equal(status, "skipped");
  assert.equal(rows.length, 0);
});

test("an assignment email is addressed to the owner and says when the callback is", () => {
  const e = buildStaffEmail(
    {
      kind: "case_assigned", ticketId: "TCK-1055", escalationId: "ESC-141", conversationId: null, channel: "web_voice",
      title: "Account access blocked", assignedBy: "The assistant", callerName: "Patrick",
      callback: { when: "Saturday 3 October at 10:30 am", link: "https://calendar.example/ev" },
    },
    "https://x.test",
  );
  assert.equal(e.subject, "Callback booked with you: Saturday 3 October at 10:30 am");
  assert.match(e.text, /When: Saturday 3 October at 10:30 am \(your time\)/);
  assert.match(e.html, /because the case is assigned to you/);
  assert.match(e.html, /calendar\.example\/ev/);
  assert.doesNotMatch(e.text, /View the call/, "no conversation, no call link");
});

test("a console assignment always emails, even with call channels filtered", async () => {
  const rows: NotificationRow[] = [];
  const status = await notifyStaff(
    { kind: "case_assigned", ticketId: "TCK-1", escalationId: null, conversationId: null, channel: "console", title: "x", assignedBy: "Ada", callerName: null, callback: null },
    { recipients: async () => [{ email: "b@x.test", name: null }], record: async (r) => void rows.push(r), send: async () => ({ ok: true }), env: { NOTIFY_CHANNELS: "phone" } },
  );
  assert.equal(status, "sent");
  assert.deepEqual(rows[0].recipients, ["b@x.test"]);
});
