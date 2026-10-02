/**
 * Callback booking (book_callback, 0013) through a real MCP client over the
 * real SQL in PGlite, with a fake Google Calendar and a fixed clock.
 *
 * The clock is Monday 5 October 2026, 08:00 UTC (09:00 in Lagos). Two staff
 * take callbacks, in this order: Ada, then Bayo, both Mon–Fri 09:00–17:00
 * Lagos time.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDb } from "../scripts/lib/test-db.ts";
import { PgliteStore } from "./lib/pglite-store.ts";
import { buildServer } from "../apps/mcp-server/src/server.ts";
import type { CalendarPort } from "../apps/mcp-server/src/lib/calendar.ts";
import type { NewEvent } from "../packages/shared/src/google-calendar.ts";

const NOW = new Date("2026-10-05T08:00:00Z");
let db: PGlite;
let store: PgliteStore;
const ADA = randomUUID();
const BAYO = randomUUID();

type FakeCal = CalendarPort & { events: { profileId: string; id: string; event: NewEvent }[]; removed: string[]; busyBy: Map<string, { start: Date; end: Date }[]>; failCreateFor: Set<string> };
function fakeCalendar(): FakeCal {
  const cal: FakeCal = {
    events: [],
    removed: [],
    busyBy: new Map(),
    failCreateFor: new Set(),
    busy: async (id) => cal.busyBy.get(id) ?? [],
    create: async (id, event) => {
      if (cal.failCreateFor.has(id)) throw new Error("Google 403: insufficient permission");
      const ev = { profileId: id, id: `ev-${cal.events.length + 1}`, event };
      cal.events.push(ev);
      return { id: ev.id, htmlLink: `https://calendar.example/${ev.id}`, meetLink: null };
    },
    remove: async (_id, eventId) => {
      cal.removed.push(eventId);
    },
  };
  return cal;
}

async function addStaff(id: string, name: string, email: string, rank: number) {
  await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, email, JSON.stringify({ full_name: name })]);
  await db.query("update profiles set role = 'support_agent', full_name = $2 where id = $1", [id, name]);
  await db.query("insert into callback_agents (profile_id, rank, timezone) values ($1, $2, 'Africa/Lagos')", [id, rank]);
  await db.query("insert into staff_calendars (profile_id, google_email, refresh_token) values ($1, $2, 'test-refresh')", [id, email]);
}

before(async () => {
  db = await createTestDb();
  store = new PgliteStore(db);
  await addStaff(ADA, "Ada Obi", "ada@relaypay.example", 1);
  await addStaff(BAYO, "Bayo Ade", "bayo@relaypay.example", 2);
});
after(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.query("update callback_bookings set status = 'cancelled' where status = 'booked'");
  await db.query("update callback_agents set takes_callbacks = true");
});

/** A web call from a guest who signed in as Tunde, with an escalation already open. */
async function call(opts: { calendar?: CalendarPort | null; channel?: string; tz?: string | null; escalate?: boolean } = {}) {
  const conversationId = randomUUID();
  await store.ensureConversation(conversationId, opts.channel ?? "web_voice");
  await db.query("update conversations set caller_name = 'Tunde Bello', caller_email = 'tunde@example.com', caller_timezone = $2 where id = $1", [
    conversationId,
    opts.tz === undefined ? "Africa/Lagos" : opts.tz,
  ]);
  const server = buildServer({ store, conversationId, calendar: opts.calendar, now: () => NOW });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  const run = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: Boolean(res.isError), body: JSON.parse(res.content[0].text) as Record<string, any> };
  };
  let escalationId: string | null = null;
  if (opts.escalate !== false) {
    const esc = await run("create_escalation", { category: "dispute", reason: "Caller wants to dispute a duplicate charge." });
    assert.equal(esc.isError, false, JSON.stringify(esc.body));
    escalationId = esc.body.escalation_id;
  }
  return { conversationId, run, escalationId };
}

const assignedTo = async (escalationId: string) =>
  (await db.query<{ e: string | null; t: string | null }>(
    "select e.assigned_to as e, t.assigned_to as t from escalations e join support_tickets t on t.ticket_id = e.ticket_id where e.escalation_id = $1",
    [escalationId],
  )).rows[0];

test("create_escalation uses the signed-in caller's name and email; the model never supplies them", async () => {
  const { escalationId } = await call({ calendar: null });
  const { rows } = await db.query<{ user_name: string; user_email: string }>("select user_name, user_email from escalations where escalation_id = $1", [escalationId]);
  assert.deepEqual(rows[0], { user_name: "Tunde Bello", user_email: "tunde@example.com" });
});

test("without a signed-in caller, create_escalation still asks for the name and email", async () => {
  const conversationId = randomUUID();
  await store.ensureConversation(conversationId, "web_voice");
  const server = buildServer({ store, conversationId, calendar: null });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  const res = (await client.callTool({ name: "create_escalation", arguments: { category: "other", reason: "Needs a specialist to call back." } })) as { content: { text: string }[]; isError?: boolean };
  assert.equal(res.isError, true);
  assert.match(JSON.parse(res.content[0].text).error, /name and email/);
});

test("books the first agent in the admin's order, assigns the case, and invites the caller", async () => {
  const cal = fakeCalendar();
  const c = await call({ calendar: cal });
  const r = await c.run("book_callback", { time: "2026-10-06T15:00" });
  assert.equal(r.body.booked, true, JSON.stringify(r.body));
  assert.equal(r.body.spoken_time, "Tuesday 6 October at 3:00 pm");
  assert.equal(r.body.specialist_first_name, "Ada");
  assert.equal(cal.events.length, 1);
  assert.equal(cal.events[0].profileId, ADA);
  assert.equal(cal.events[0].event.start.toISOString(), "2026-10-06T14:00:00.000Z", "15:00 Lagos is 14:00 UTC");
  assert.deepEqual(cal.events[0].event.attendees, [{ email: "tunde@example.com", displayName: "Tunde Bello" }]);
  assert.deepEqual(await assignedTo(c.escalationId!), { e: ADA, t: ADA });
  const { rows } = await db.query<{ callback_at: Date; preferred_time_text: string }>("select callback_at, preferred_time_text from escalations where escalation_id = $1", [c.escalationId]);
  assert.equal(new Date(rows[0].callback_at).toISOString(), "2026-10-06T14:00:00.000Z");
  assert.equal(rows[0].preferred_time_text, "Tuesday 6 October at 3:00 pm");
  const events = await db.query<{ action: string }>("select action from case_events where escalation_id = $1 order by created_at", [c.escalationId]);
  assert.deepEqual(events.rows.map((e) => e.action).sort(), ["assigned", "callback_scheduled"]);
});

test("an agent busy on Google Calendar is skipped for the next in order", async () => {
  const cal = fakeCalendar();
  cal.busyBy.set(ADA, [{ start: new Date("2026-10-06T13:30:00Z"), end: new Date("2026-10-06T15:00:00Z") }]);
  const c = await call({ calendar: cal });
  const r = await c.run("book_callback", { time: "2026-10-06T15:00" });
  assert.equal(r.body.specialist_first_name, "Bayo");
  assert.deepEqual(await assignedTo(c.escalationId!), { e: BAYO, t: BAYO });
});

test("other callers' bookings count: the same slot goes to the next agent, then nobody", async () => {
  const cal = fakeCalendar();
  const first = await (await call({ calendar: cal })).run("book_callback", { time: "2026-10-07T10:00" });
  const second = await (await call({ calendar: cal })).run("book_callback", { time: "2026-10-07T10:00" });
  const third = await (await call({ calendar: cal })).run("book_callback", { time: "2026-10-07T10:00" });
  assert.equal(first.body.specialist_first_name, "Ada");
  assert.equal(second.body.specialist_first_name, "Bayo");
  assert.equal(third.body.booked, false);
  assert.equal(third.body.reason, "no_specialist_free_then");
  assert.deepEqual(third.body.alternatives.map((a: any) => a.local_time), ["2026-10-07T10:30", "2026-10-07T11:00", "2026-10-07T11:30"]);
});

test("outside working hours, nothing is booked and the next working slots are offered", async () => {
  const cal = fakeCalendar();
  const c = await call({ calendar: cal });
  const r = await c.run("book_callback", { time: "2026-10-10T11:00" }); // Saturday
  assert.equal(r.body.booked, false);
  assert.equal(r.body.alternatives[0].spoken_time, "Monday 12 October at 9:00 am");
  assert.equal(cal.events.length, 0);
});

test("the caller's time zone is respected: 10:00 in Nairobi is 08:00 in Lagos", async () => {
  const cal = fakeCalendar();
  const c = await call({ calendar: cal, tz: "Africa/Nairobi" });
  const early = await c.run("book_callback", { time: "2026-10-06T09:30" }); // 07:30 Lagos: before hours
  assert.equal(early.body.booked, false);
  assert.equal(early.body.alternatives[0].local_time, "2026-10-06T11:00", "first slot is 09:00 Lagos, said as 11:00 Nairobi");
  const ok = await c.run("book_callback", { time: "2026-10-06T11:00" });
  assert.equal(ok.body.booked, true);
  assert.equal(cal.events[0].event.start.toISOString(), "2026-10-06T08:00:00.000Z");
});

test("too soon, unparseable, or no escalation yet", async () => {
  const c = await call({ calendar: fakeCalendar() });
  const soon = await c.run("book_callback", { time: "2026-10-05T09:30" }); // 30 min from now
  assert.equal(soon.body.reason, "too_soon");
  assert.equal(soon.body.alternatives[0].local_time, "2026-10-05T10:00");
  const words = await c.run("book_callback", { time: "tomorrow afternoon" });
  assert.equal(words.isError, true);
  const none = await (await call({ calendar: fakeCalendar(), escalate: false })).run("book_callback", { time: "2026-10-06T15:00" });
  assert.equal(none.isError, true);
  assert.match(none.body.error, /create_escalation first/);
});

test("changing the time releases the old booking and its calendar event", async () => {
  const cal = fakeCalendar();
  const c = await call({ calendar: cal });
  await c.run("book_callback", { time: "2026-10-08T10:00" });
  const moved = await c.run("book_callback", { time: "2026-10-08T14:00" });
  assert.equal(moved.body.booked, true);
  assert.equal(moved.body.rebooked, true);
  assert.deepEqual(cal.removed, ["ev-1"]);
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from callback_bookings where escalation_id = $1 and status = 'booked'", [c.escalationId]);
  assert.equal(rows[0].n, 1);
});

test("a calendar that refuses the event moves the booking to the next agent", async () => {
  const cal = fakeCalendar();
  cal.failCreateFor.add(ADA);
  const c = await call({ calendar: cal });
  const r = await c.run("book_callback", { time: "2026-10-09T10:00" });
  assert.equal(r.body.specialist_first_name, "Bayo");
  const { rows } = await db.query<{ last_error: string }>("select last_error from staff_calendars where profile_id = $1", [ADA]);
  assert.match(rows[0].last_error, /403/);
  await db.query("update staff_calendars set last_error = null where profile_id = $1", [ADA]);
});

test("no calendar, a test channel, or nobody on the rota: the time becomes a preference", async () => {
  const c = await call({ calendar: null });
  const unconfigured = await c.run("book_callback", { time: "2026-10-06T15:00" });
  assert.equal(unconfigured.body.reason, "calendar_not_configured");
  // The server keeps the time itself: it can't be lost if the model doesn't follow up.
  const { rows } = await db.query<{ call_booked: boolean; preferred_time_text: string; callback_at: Date | null }>(
    "select call_booked, preferred_time_text, callback_at from escalations where escalation_id = $1",
    [c.escalationId],
  );
  assert.deepEqual(rows[0], { call_booked: true, preferred_time_text: "Tuesday 6 October at 3:00 pm", callback_at: null });
  const evalRun = await (await call({ calendar: fakeCalendar(), channel: "eval" })).run("book_callback", { time: "2026-10-06T15:00" });
  assert.equal(evalRun.body.reason, "calendar_booking_off_for_this_channel");
  await db.query("update callback_agents set takes_callbacks = false");
  const nobody = await (await call({ calendar: fakeCalendar() })).run("book_callback", { time: "2026-10-06T15:00" });
  assert.equal(nobody.body.reason, "no_agent_has_a_calendar_connected");
});

test("the database refuses a double booking of one agent's slot, whatever the code above it does", async () => {
  const a = await call({ calendar: null });
  const b = await call({ calendar: null });
  const slot = ["2026-10-13T09:00:00Z", "2026-10-13T09:30:00Z"];
  const first = await store.bookSlot({ escalationId: a.escalationId!, profileId: ADA, start: new Date(slot[0]), end: new Date(slot[1]), timezone: "Africa/Lagos", label: "x" });
  const second = await store.bookSlot({ escalationId: b.escalationId!, profileId: ADA, start: new Date(slot[0]), end: new Date(slot[1]), timezone: "Africa/Lagos", label: "x" });
  assert.ok(first.booking_id);
  assert.equal(second.booking_id, null);
  assert.deepEqual(await assignedTo(b.escalationId!), { e: null, t: null }, "the loser is not assigned");
});
