/**
 * Turning what a speech-to-text engine heard into the identifiers in the
 * database.
 *
 * Callers say "T X N nine zero zero one", "transaction 9001", "txn-9001" or
 * just "nine oh oh one". The model is told to pass along what it heard, and
 * this is the one place that decides what that means, so a lookup never
 * depends on the model reformatting an ID correctly.
 */

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", nought: "0",
  one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};
// Deliberately absent: "to", "too", "for", "ate". Homophones read as digits
// turn "check transaction for nine zero zero one" into 49001.

const TEENS_AND_TENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

export type ReferenceKind = "TXN" | "PAY" | "CUS";

const KIND_WORDS: Record<ReferenceKind, RegExp> = {
  TXN: /\b(t\s*x\s*n|transaction|trans|tx)\b/gi,
  PAY: /\b(p\s*a\s*y|payout|pay\s*out|payment)\b/gi,
  CUS: /\b(c\s*u\s*s|customer|cust)\b/gi,
};

/**
 * Spoken numbers to digits. Handles digit-by-digit ("nine zero zero one"),
 * "double/triple" ("nine double oh one") and simple compounds
 * ("nine thousand one", "ninety oh one"). Anything it cannot read is left
 * alone, so the result simply fails to match rather than matching wrongly.
 */
export function spokenDigits(input: string): string {
  const tokens = input.toLowerCase().replace(/[-,.]/g, " ").split(/\s+/).filter(Boolean);
  let out = "";
  let pendingThousand: number | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (/^\d+$/.test(t)) {
      out += t;
    } else if ((t === "double" || t === "triple") && next && DIGIT_WORDS[next]) {
      out += DIGIT_WORDS[next].repeat(t === "double" ? 2 : 3);
      i++;
    } else if (DIGIT_WORDS[t] !== undefined && next === "thousand") {
      pendingThousand = Number(DIGIT_WORDS[t]) * 1000;
      i++;
    } else if (TEENS_AND_TENS[t] !== undefined) {
      let n = TEENS_AND_TENS[t];
      if (n >= 20 && next && DIGIT_WORDS[next] && DIGIT_WORDS[next] !== "0") {
        n += Number(DIGIT_WORDS[next]);
        i++;
      }
      out += String(n);
    } else if (DIGIT_WORDS[t] !== undefined) {
      out += DIGIT_WORDS[t];
    } else if (t === "hundred" && out.length > 0) {
      out += "00";
    }
    // Other words ("number", "reference", "is") are filler; skip them.
  }

  if (pendingThousand !== null) {
    const rest = out === "" ? 0 : Number(out);
    return String(pendingThousand + rest);
  }
  return out;
}

/**
 * Normalise a transaction, payout or customer reference to `KIND-digits`.
 * Returns null when no digits can be found, so the tool can ask the caller to
 * repeat it rather than guess.
 */
export function normalizeReference(kind: ReferenceKind, raw: string | null | undefined): string | null {
  if (!raw) return null;
  const direct = raw.trim().toUpperCase().match(new RegExp(`^${kind}[\\s_-]*(\\d{2,})$`));
  if (direct) return `${kind}-${direct[1]}`;

  const withoutKind = raw.replace(KIND_WORDS[kind], " ");
  const digits = spokenDigits(withoutKind);
  if (!/^\d{2,}$/.test(digits)) return null;
  return `${kind}-${digits}`;
}

/**
 * Spoken email to written: "amara at lagos ledger dot example" ->
 * "amara@lagosledger.example". Only rewrites the spoken forms; a typed email
 * passes through lower-cased.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = ` ${raw.trim().toLowerCase()} `;
  s = s
    .replace(/\s+at\s+/g, "@")
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+(underscore)\s+/g, "_")
    .replace(/\s+(dash|hyphen)\s+/g, "-")
    .replace(/\s+/g, "");
  return s || null;
}

export function isPlausibleEmail(email: string): boolean {
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(email);
}

/** First name, lower-cased, for comparing "Amara" with "Amara Okafor". */
export function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** "2026-08-19" -> "August 19, 2026". Voice-friendly; no weekday guesswork. */
export function spokenDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
