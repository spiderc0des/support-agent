/**
 * The booking tool's view of staff calendars. The real one talks to Google
 * with each agent's stored refresh token; tests pass a fake.
 */
import { accessToken, busyTimes, calendarConfigured, createEvent, deleteEvent, type NewEvent } from "@relaypay/shared/google-calendar";
import type { Store } from "../store.ts";

export interface CalendarPort {
  busy(profileId: string, from: Date, to: Date): Promise<{ start: Date; end: Date }[]>;
  create(profileId: string, event: NewEvent): Promise<{ id: string; htmlLink: string | null; meetLink: string | null }>;
  remove(profileId: string, eventId: string): Promise<void>;
}

export function googleCalendar(store: Store): CalendarPort | null {
  if (!calendarConfigured()) return null;
  // Access tokens last an hour; one booking asks for several per agent.
  const tokens = new Map<string, Promise<string>>();
  const token = (profileId: string) => {
    let t = tokens.get(profileId);
    if (!t) {
      t = store.calendarToken(profileId).then((refresh) => {
        if (!refresh) throw new Error("calendar not connected");
        return accessToken(refresh);
      });
      t.catch(() => tokens.delete(profileId));
      tokens.set(profileId, t);
    }
    return t;
  };
  return {
    busy: async (id, from, to) => busyTimes(await token(id), from, to),
    create: async (id, ev) => createEvent(await token(id), ev),
    remove: async (id, eventId) => deleteEvent(await token(id), eventId),
  };
}
