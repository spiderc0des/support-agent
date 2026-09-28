import { z } from "zod";

/**
 * Every value set the system agrees on, in one place.
 *
 * The SQL CHECK constraints (supabase/migrations) and the skills
 * (.claude/skills) must use exactly these values. `npm run lint:skills`
 * checks the skills against this file and `npm run test:sql` checks the
 * migrations, so the three cannot drift apart silently.
 */

/** The four response paths from the support decision rules. */
export const ANSWER_PATHS = ["answer", "clarify", "escalate", "decline"] as const;
export const AnswerPath = z.enum(ANSWER_PATHS);
export type AnswerPath = z.infer<typeof AnswerPath>;

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export const Confidence = z.enum(CONFIDENCE_LEVELS);
export type Confidence = z.infer<typeof Confidence>;

export const CHANNELS = ["web_voice", "phone", "text", "eval", "dev"] as const;
export const Channel = z.enum(CHANNELS);
export type Channel = z.infer<typeof Channel>;

export const CONVERSATION_STATUSES = ["active", "resolved", "ticketed", "escalated", "abandoned", "error"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/**
 * Ticket categories. A superset of escalation categories, because every
 * escalation is filed on a ticket of the same category.
 */
export const TICKET_CATEGORIES = [
  "account",
  "compliance",
  "dispute",
  "payment",
  "payout",
  "invoice",
  "technical",
  "other",
] as const;
export const TicketCategory = z.enum(TICKET_CATEGORIES);
export type TicketCategory = z.infer<typeof TicketCategory>;

/** Escalation categories, fixed by the escalation rules. */
export const ESCALATION_CATEGORIES = ["compliance", "account", "dispute", "payment", "other"] as const;
export const EscalationCategory = z.enum(ESCALATION_CATEGORIES);
export type EscalationCategory = z.infer<typeof EscalationCategory>;

export const PRIORITIES = ["low", "medium", "high"] as const;
export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;

export const RECORD_STATUSES = ["open", "in_progress", "closed"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export const TOOL_CALL_STATUSES = ["success", "not_found", "invalid_input", "denied", "error"] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

/** Event types the agent may log itself through log_conversation_event. */
export const AGENT_EVENT_TYPES = [
  "policy_refusal",
  "identity_unverified",
  "sensitive_data_withheld",
  "clarification_limit_reached",
  "note",
] as const;
export const AgentEventType = z.enum(AGENT_EVENT_TYPES);
export type AgentEventType = z.infer<typeof AgentEventType>;

/** Event types only code writes. The agent cannot log these. */
export const SYSTEM_EVENT_TYPES = [
  "ticket_created",
  "escalation_created",
  "customer_verified",
  "ownership_blocked",
  "session_started",
  "turn_error",
  "call_ended",
] as const;
export type SystemEventType = (typeof SYSTEM_EVENT_TYPES)[number];

/** Seed-data value sets, as the schema guide defines them. */
export const ACCOUNT_STATUSES = ["active", "restricted", "pending verification"] as const;
export const KYC_STATUSES = ["pending", "approved", "review required"] as const;
export const TRANSACTION_STATUSES = ["processing", "completed", "delayed", "failed", "review required"] as const;
export const PAYOUT_STATUSES = ["scheduled", "processing", "completed", "failed", "review required"] as const;
export const TRANSACTION_TYPES = ["incoming transfer", "outgoing payout", "invoice payment"] as const;

/** Staff roles for the support console. */
export const STAFF_ROLES = ["support_agent", "admin"] as const;
export const StaffRole = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof StaffRole>;

export const ROLE_LABEL: Record<StaffRole, string> = { support_agent: "Support agent", admin: "Admin" };

/** What a person can do to a ticket or escalation; each is one case_events row. */
export const CASE_ACTIONS = ["status_changed", "assigned", "unassigned", "note_added", "callback_scheduled"] as const;
export type CaseAction = (typeof CASE_ACTIONS)[number];
