// Redaction (spec 3.4): never persist secrets or raw sensitive data into artifacts or logs.
// Two layers: (1) explicit — any input param the artifact schema marks `sensitive: true` is
// masked wherever we log or serialize param values; (2) heuristic — generic PII-shaped strings
// (SSN, long account/card-like digit runs) are masked even if not explicitly flagged, as a
// defense-in-depth backstop against the caller forgetting to mark a field.
const REDACTED = "***redacted***";

const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;
const LONG_DIGIT_RUN_PATTERN = /\b\d{9,}\b/; // account/card-number-shaped
const SECRET_KEY_NAME_PATTERN = /(password|secret|token|api[_-]?key|ssn|social.?security)/i;

export function looksSensitive(value: string): boolean {
  return SSN_PATTERN.test(value) || LONG_DIGIT_RUN_PATTERN.test(value);
}

export function redactValue(value: string): string {
  return REDACTED;
}

// Redacts a flat param map for logging, given the set of param names the artifact explicitly
// marks sensitive plus the heuristic backstop above.
export function redactParams(params: Record<string, unknown>, sensitiveNames: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const stringValue = String(value);
    if (sensitiveNames.has(key) || SECRET_KEY_NAME_PATTERN.test(key) || looksSensitive(stringValue)) {
      out[key] = REDACTED;
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Redacts free-text (e.g. a page text snapshot or LLM reasoning string) before it is written to a
// log file, masking any substrings that look like SSNs or long digit runs.
export function redactText(text: string): string {
  return text.replace(new RegExp(SSN_PATTERN, "g"), REDACTED).replace(new RegExp(LONG_DIGIT_RUN_PATTERN, "g"), REDACTED);
}
