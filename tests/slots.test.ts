import { test } from "node:test";
import assert from "node:assert/strict";
import {
  localIso,
  nowInZone,
  parseLocalTime,
  resolveCallerTimeZone,
  snapToSlot,
  spokenSlot,
  withinWorkingHours,
  zonedToUtc,
} from "../packages/shared/src/slots.ts";

const hours = { timezone: "Africa/Lagos", work_days: [1, 2, 3, 4, 5], work_start: "09:00", work_end: "17:00" };

test("wall-clock times convert to the right instant, including across daylight saving", () => {
  assert.equal(zonedToUtc(2026, 10, 6, 15, 0, "Africa/Lagos").toISOString(), "2026-10-06T14:00:00.000Z");
  assert.equal(zonedToUtc(2026, 10, 6, 15, 0, "Africa/Nairobi").toISOString(), "2026-10-06T12:00:00.000Z");
  assert.equal(zonedToUtc(2026, 7, 1, 9, 0, "Europe/London").toISOString(), "2026-07-01T08:00:00.000Z", "BST");
  assert.equal(zonedToUtc(2026, 12, 1, 9, 0, "Europe/London").toISOString(), "2026-12-01T09:00:00.000Z", "GMT");
});

test("only a concrete local time parses", () => {
  assert.equal(parseLocalTime("2026-10-06T15:00", "Africa/Lagos")?.toISOString(), "2026-10-06T14:00:00.000Z");
  assert.equal(parseLocalTime("2026-10-06 9:30", "Africa/Lagos")?.toISOString(), "2026-10-06T08:30:00.000Z");
  for (const bad of ["tomorrow at 3", "2026-02-30T10:00", "2026-10-06T25:00", "2026-10-06T15:00Z", ""]) {
    assert.equal(parseLocalTime(bad, "Africa/Lagos"), null, bad);
  }
});

test("slots snap up to :00 or :30", () => {
  assert.equal(snapToSlot(new Date("2026-10-06T14:10:00Z")).toISOString(), "2026-10-06T14:30:00.000Z");
  assert.equal(snapToSlot(new Date("2026-10-06T14:30:00Z")).toISOString(), "2026-10-06T14:30:00.000Z");
});

test("a slot must fit entirely inside working hours on a working day", () => {
  assert.equal(withinWorkingHours(new Date("2026-10-05T08:00:00Z"), hours), true, "Mon 09:00 Lagos");
  assert.equal(withinWorkingHours(new Date("2026-10-05T07:30:00Z"), hours), false, "08:30");
  assert.equal(withinWorkingHours(new Date("2026-10-05T15:30:00Z"), hours), true, "16:30 ends at 17:00");
  assert.equal(withinWorkingHours(new Date("2026-10-05T16:00:00Z"), hours), false, "17:00 ends after hours");
  assert.equal(withinWorkingHours(new Date("2026-10-10T10:00:00Z"), hours), false, "Saturday");
});

test("slots are said the way a person would say them, in the caller's zone", () => {
  const t = new Date("2026-10-06T14:00:00Z");
  assert.equal(spokenSlot(t, "Africa/Lagos"), "Tuesday 6 October at 3:00 pm");
  assert.equal(spokenSlot(t, "Africa/Nairobi"), "Tuesday 6 October at 5:00 pm");
  assert.equal(localIso(t, "Africa/Nairobi"), "2026-10-06T17:00");
  assert.match(nowInZone(t, "Africa/Lagos"), /^Tuesday 6 October 2026, 3:00 pm$/);
});

test("an unknown or missing caller zone falls back to the default", () => {
  assert.equal(resolveCallerTimeZone("Africa/Accra"), "Africa/Accra");
  assert.equal(resolveCallerTimeZone("Mars/Olympus", "Africa/Nairobi"), "Africa/Nairobi");
  assert.equal(resolveCallerTimeZone(null, undefined), "Africa/Lagos");
});
