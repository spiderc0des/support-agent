/**
 * Email someone about a case without holding up the call: the tool answers
 * straight away and the email follows. A mail failure is recorded on the
 * case, never surfaced to the caller.
 */
import { notifyStaff, type Recipient, type StaffEvent } from "@relaypay/shared/notify";
import type { ToolContext } from "./tooling.ts";

export const pendingNotifications = new Set<Promise<unknown>>();

export function notifyInBackground(ctx: ToolContext, ev: StaffEvent, recipients: () => Promise<Recipient[]>) {
  const p = notifyStaff(ev, { recipients, record: (row) => ctx.store.logNotification(row) }).finally(() => pendingNotifications.delete(p));
  pendingNotifications.add(p);
}
