/**
 * Callback slots: 30-minute appointments, worked out across time zones.
 *
 * The caller asks for a wall-clock time in their own zone ("tomorrow at 3").
 * Each human agent works set hours in theirs. Everything is converted to UTC
 * instants to compare, using the platform's time-zone database (Intl), so
 * there is no date library and daylight-saving changes are handled.
 */

export const SLOT_MINUTES = 30;
/** No booking sooner than this: a person needs time to see it. */
export const MIN_LEAD_MINUTES = 60;
/** How far ahead a callback can be booked. */
export const MAX_DAYS_AHEAD = 14;
export const DEFAULT_TIMEZONE = "Africa/Lagos";

export type WorkingHours = {
  timezone: string;
  /** ISO weekdays, 1 = Monday ... 7 = Sunday. */
  work_days: number[];
  /** "HH:MM" or "HH:MM:SS", in `timezone`. */
  work_start: string;
  work_end: string;
};

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The zone a caller's times are read in: theirs if known, else the deployment default. */
export function resolveCallerTimeZone(tz: string | null | undefined, envDefault = process.env.CALLBACK_DEFAULT_TIMEZONE): string {
  if (isValidTimeZone(tz)) return tz;
  return isValidTimeZone(envDefault) ? envDefault : DEFAULT_TIMEZONE;
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The wall-clock reading of an instant in a zone. */
export function zonedParts(date: Date, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const m = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(m.year),
    month: Number(m.month),
    day: Number(m.day),
    hour: Number(m.hour),
    minute: Number(m.minute),
    weekday: WEEKDAY[m.weekday] ?? 0,
  };
}

function offsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(date.getTime() / 60000) * 60000;
}

/** The instant a wall-clock time in a zone refers to. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let t = guess - offsetMs(new Date(guess), tz);
  const second = offsetMs(new Date(t), tz);
  if (guess - second !== t) t = guess - second; // across a DST change
  return new Date(t);
}

/**
 * Parse a local time such as "2026-10-03T15:00" (no offset: it is a wall
 * clock in `tz`). Returns null for anything else, so the model must hand over
 * a concrete time rather than words.
 */
export function parseLocalTime(text: string, tz: string): Date | null {
  const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const date = zonedToUtc(y, mo, d, h, mi, tz);
  // Reject dates that rolled over (Feb 30th and the like).
  const back = zonedParts(date, tz);
  return back.day === d && back.month === mo ? date : null;
}

/** Round up to the next slot boundary (:00 or :30). */
export function snapToSlot(date: Date): Date {
  const step = SLOT_MINUTES * 60_000;
  return new Date(Math.ceil(date.getTime() / step) * step);
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};

/** Whether the whole slot starting at `start` falls inside the agent's working hours. */
export function withinWorkingHours(start: Date, hours: WorkingHours): boolean {
  const p = zonedParts(start, hours.timezone);
  if (!hours.work_days.includes(p.weekday)) return false;
  const from = p.hour * 60 + p.minute;
  return from >= minutes(hours.work_start) && from + SLOT_MINUTES <= minutes(hours.work_end);
}

export type Interval = { start: Date; end: Date };

export const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

export function slotInterval(start: Date): Interval {
  return { start, end: new Date(start.getTime() + SLOT_MINUTES * 60_000) };
}

/** "Saturday 3 October at 3:00 pm", how the agent says a slot to the caller. */
export function spokenSlot(start: Date, tz: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" })
    .format(start)
    .replace(/^(\w+),/, "$1");
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true })
    .format(start)
    .toLowerCase();
  return `${day} at ${time}`;
}

/** "2026-10-03T15:00", a slot as the caller's wall clock, for the model to echo back if it rebooks. */
export function localIso(start: Date, tz: string): string {
  const p = zonedParts(start, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** "Thursday 2 October 2026, 4:05 pm" in a zone: what the agent needs to turn "tomorrow at 3" into a date. */
export function nowInZone(now: Date, tz: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" })
    .format(now)
    .replace(/^(\w+),/, "$1");
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(now).toLowerCase();
  return `${day}, ${time}`;
}
