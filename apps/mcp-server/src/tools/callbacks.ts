/**
 * book_callback: turn a caller's requested time into a confirmed callback
 * with a person.
 *
 * Staff are checked in the order the admin set (callback_agents.rank). The
 * first one who is working at that time, free on their Google Calendar, and
 * not already booked by another caller gets it: the event goes on their
 * calendar with the caller invited (and a Meet link), and the case is
 * assigned to them. Two callers racing for the same slot can't both win: the
 * database's unique index on (agent, slot) settles it, and the loser moves on
 * to the next agent.
 *
 * When nobody is free then, nothing is booked and the nearest free slots come
 * back as alternatives for the caller to choose from. When booking isn't
 * possible at all, the server keeps the requested time on the escalation as
 * a preference itself, so it can't be lost if the model doesn't follow up.
 */
import { z } from "zod";
import {
  MAX_DAYS_AHEAD,
  MIN_LEAD_MINUTES,
  SLOT_MINUTES,
  localIso,
  overlaps,
  parseLocalTime,
  resolveCallerTimeZone,
  slotInterval,
  snapToSlot,
  spokenSlot,
  withinWorkingHours,
  type Interval,
} from "@relaypay/shared/slots";
import type { CallbackAgent, ConversationState } from "../store.ts";
import type { ToolContext, ToolHandler, ToolOutcome } from "../lib/tooling.ts";
import { googleCalendar } from "../lib/calendar.ts";

export const bookCallbackShape = {
  time: z
    .string()
    .max(40)
    .describe(
      "The requested start in the caller's local time as YYYY-MM-DDTHH:MM, worked out from what they said and the call context's local time (e.g. 'tomorrow at 3pm' -> '2026-10-03T15:00'). For a vague time use the start of it: morning 09:00, afternoon 14:00, evening 17:00, 'any time' 09:00. Never ask the caller to narrow it down.",
    ),
};
type Args = { time: string };

/** Channels that may create real calendar events. Evals and tests never do. */
function bookingChannels(): string[] {
  return (process.env.CALLBACK_CHANNELS ?? "web_voice,phone").split(",").map((c) => c.trim()).filter(Boolean);
}

export const callerTimeZone = (conversation: ConversationState) => resolveCallerTimeZone(conversation.caller_timezone);

async function keepAsPreference(ctx: ToolContext, escalationId: string, label: string, why: string): Promise<ToolOutcome> {
  await ctx.store.recordPreferredTime(escalationId, label);
  return {
    status: "success",
    result: {
      booked: false,
      reason: why,
      recorded_preference: label,
      guidance:
        "Nothing was booked, but the time is saved on the escalation as their preference. Tell the caller a specialist will confirm that time by email; don't say it's booked.",
    },
  };
}

export const bookCallback: ToolHandler<Args> = async ({ time }, conversation, ctx) => {
  const tz = callerTimeZone(conversation);
  const escalation = await ctx.store.escalationForConversation(conversation.id);
  if (!escalation) {
    return {
      status: "invalid_input",
      result: { error: "There is no escalation on this call yet. A callback is booked for an escalation: create_escalation first, then book." },
      error: "no escalation on this call",
    };
  }

  const requested = parseLocalTime(time, tz);
  if (!requested) {
    return {
      status: "invalid_input",
      result: { error: `"${time}" isn't a time I can book. Pass the caller's local time as YYYY-MM-DDTHH:MM.` },
      error: `unparseable time "${time}"`,
    };
  }

  const now = ctx.now?.() ?? new Date();
  const earliest = snapToSlot(new Date(now.getTime() + MIN_LEAD_MINUTES * 60_000));
  const latest = new Date(now.getTime() + MAX_DAYS_AHEAD * 86_400_000);
  const start = snapToSlot(requested);
  const asked = spokenSlot(start, tz);

  if (!bookingChannels().includes(conversation.channel)) return keepAsPreference(ctx, escalation.escalation_id, asked, "calendar_booking_off_for_this_channel");
  const calendar = ctx.calendar === undefined ? googleCalendar(ctx.store) : ctx.calendar;
  if (!calendar) return keepAsPreference(ctx, escalation.escalation_id, asked, "calendar_not_configured");
  const agents = (await ctx.store.callbackAgents()).filter((a) => a.has_calendar);
  if (!agents.length) return keepAsPreference(ctx, escalation.escalation_id, asked, "no_agent_has_a_calendar_connected");

  // One free/busy read per agent covers the request and the alternatives.
  const from = start < earliest ? earliest : start;
  const windowEnd = new Date(Math.min(latest.getTime(), from.getTime() + 7 * 86_400_000));
  const busy = new Map<string, Interval[]>();
  const usable: CallbackAgent[] = [];
  await Promise.all(
    agents.map(async (a) => {
      try {
        busy.set(a.profile_id, await calendar.busy(a.profile_id, from, windowEnd));
        usable.push(a);
      } catch (err) {
        await ctx.store.recordCalendarError(a.profile_id, err instanceof Error ? err.message : String(err));
      }
    }),
  );
  usable.sort((x, y) => x.rank - y.rank);
  if (!usable.length) return keepAsPreference(ctx, escalation.escalation_id, asked, "calendars_unreachable");

  const taken = new Set((await ctx.store.bookedSlots(from, windowEnd)).map((b) => `${b.profile_id}|${new Date(b.slot_start).toISOString()}`));
  const isFree = (a: CallbackAgent, slot: Date) =>
    withinWorkingHours(slot, a) &&
    !taken.has(`${a.profile_id}|${slot.toISOString()}`) &&
    !(busy.get(a.profile_id) ?? []).some((b) => overlaps(b, slotInterval(slot)));

  const alternatives = (after: Date) => {
    const out: { local_time: string; spoken_time: string }[] = [];
    for (let t = after; t < windowEnd && out.length < 3; t = new Date(t.getTime() + SLOT_MINUTES * 60_000)) {
      if (usable.some((a) => isFree(a, t))) out.push({ local_time: localIso(t, tz), spoken_time: spokenSlot(t, tz) });
    }
    return out;
  };
  const offer = async (reason: string, after: Date): Promise<ToolOutcome> => {
    const alts = alternatives(after);
    if (!alts.length) await ctx.store.recordPreferredTime(escalation.escalation_id, asked);
    return {
      status: "success",
      result: {
        booked: false,
        reason,
        requested_time: asked,
        alternatives: alts,
        guidance: alts.length
          ? "Nothing is booked yet. Say the requested time isn't available and offer these alternatives (spoken_time). When the caller picks one, call book_callback with its local_time."
          : "No specialist is free in the next week. The requested time is saved as their preference; say a specialist will confirm a time by email.",
      },
      summary: { booked: false, reason, requested: start.toISOString(), alternatives: alts.map((a) => a.local_time) },
    };
  };

  if (start < earliest) return offer("too_soon", earliest);
  if (start > latest) return offer("too_far_ahead", earliest);

  for (const agent of usable) {
    if (!isFree(agent, start)) continue;
    const interval = slotInterval(start);

    let event;
    try {
      event = await calendar.create(agent.profile_id, {
        summary: `RelayPay callback · ${escalation.escalation_id}${escalation.company_name ? ` · ${escalation.company_name}` : ""}`,
        description: `A RelayPay specialist will join this call with ${escalation.user_name}.\n\nAbout: ${escalation.reason}\nReference: ${escalation.escalation_id}`,
        start: interval.start,
        end: interval.end,
        timezone: agent.timezone,
        attendees: [{ email: escalation.user_email, displayName: escalation.user_name }],
      });
    } catch (err) {
      await ctx.store.recordCalendarError(agent.profile_id, err instanceof Error ? err.message : String(err));
      continue;
    }

    const booking = await ctx.store.bookSlot({ escalationId: escalation.escalation_id, profileId: agent.profile_id, start, end: interval.end, timezone: tz, label: asked });
    if (!booking.booking_id) {
      // Another caller took this agent's slot a moment ago.
      await calendar.remove(agent.profile_id, event.id).catch(() => {});
      taken.add(`${agent.profile_id}|${start.toISOString()}`);
      continue;
    }
    await ctx.store.setBookingEvent(booking.booking_id, event.id, event.htmlLink);
    if (booking.replaced_event_id && booking.replaced_profile_id) {
      await calendar.remove(booking.replaced_profile_id, booking.replaced_event_id).catch(() => {});
    }

    return {
      status: "success",
      result: {
        booked: true,
        spoken_time: asked,
        local_time: localIso(start, tz),
        specialist_first_name: agent.name.split(/\s+/)[0],
        rebooked: Boolean(booking.replaced_booking_id),
        guidance:
          "Confirm the callback: say it's booked for spoken_time with specialist_first_name from the RelayPay team, and that a calendar invite with a video link is on its way to their email. Don't read the email address out.",
      },
      summary: {
        booked: true,
        escalation_id: escalation.escalation_id,
        slot_start: start.toISOString(),
        caller_timezone: tz,
        profile_id: agent.profile_id,
        booking_id: booking.booking_id,
        rebooked: Boolean(booking.replaced_booking_id),
      },
    };
  }

  return offer("no_specialist_free_then", new Date(start.getTime() + SLOT_MINUTES * 60_000));
};
