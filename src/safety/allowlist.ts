// Enforces the allowlist requirement (spec 3.4): the agent (discovery loop) and the replay
// engine must not act outside a configured set of origins/action types. This is loaded once and
// consulted by both the discovery loop (before every navigate/act) and the replay engine (before
// every step), so there is exactly one place the policy is defined.
import { readFileSync } from "node:fs";
import { z } from "zod";

const AllowlistConfigSchema = z.object({
  allowedOrigins: z.array(z.string()),
  allowedActions: z.array(z.string()),
  riskyNamePatterns: z.array(z.string()),
});
export type AllowlistConfig = z.infer<typeof AllowlistConfigSchema>;

export function loadAllowlist(path = "allowlist.config.json"): AllowlistConfig {
  const raw = readFileSync(path, "utf-8");
  return AllowlistConfigSchema.parse(JSON.parse(raw));
}

export class AllowlistViolation extends Error {
  constructor(
    message: string,
    public readonly kind: "origin" | "action"
  ) {
    super(message);
    this.name = "AllowlistViolation";
  }
}

export function assertOriginAllowed(config: AllowlistConfig, url: string): void {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new AllowlistViolation(`Cannot navigate to unparseable URL: ${url}`, "origin");
  }
  if (!config.allowedOrigins.includes(origin)) {
    throw new AllowlistViolation(
      `Origin "${origin}" is not in the allowlist (${config.allowedOrigins.join(", ")}).`,
      "origin"
    );
  }
}

export function assertActionAllowed(config: AllowlistConfig, action: string): void {
  if (!config.allowedActions.includes(action)) {
    throw new AllowlistViolation(`Action type "${action}" is not in the allowlist.`, "action");
  }
}
