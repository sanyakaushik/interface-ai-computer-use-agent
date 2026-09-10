// The error taxonomy (spec 3.3): separates expected business outcomes ("no such member" is a
// legitimate answer, not a crash) from recoverable runtime conditions (a known interstitial, a
// one-shot session-timeout retry) from everything else, which is a hard failure. Rules are
// per-target-app config, not code, so extending to a new app/vendor product doesn't touch the
// replay engine.
import { readFileSync } from "node:fs";
import { z } from "zod";

const OutcomeRulesSchema = z.object({
  businessOutcomes: z.array(z.object({ code: z.string(), textIncludes: z.string(), message: z.string() })),
  recoverable: z.array(z.object({ code: z.string(), textIncludes: z.string(), recovery: z.enum(["renavigate-once"]) })),
});
export type OutcomeRules = z.infer<typeof OutcomeRulesSchema>;

export function loadOutcomeRules(path: string): OutcomeRules {
  return OutcomeRulesSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
}

export type ClassifiedOutcome =
  | { type: "business_outcome"; code: string; message: string }
  | { type: "recoverable"; code: string; recovery: "renavigate-once" }
  | { type: "none" };

export function classifyPageText(rules: OutcomeRules, visibleText: string): ClassifiedOutcome {
  for (const rule of rules.businessOutcomes) {
    if (visibleText.includes(rule.textIncludes)) {
      return { type: "business_outcome", code: rule.code, message: rule.message };
    }
  }
  for (const rule of rules.recoverable) {
    if (visibleText.includes(rule.textIncludes)) {
      return { type: "recoverable", code: rule.code, recovery: rule.recovery };
    }
  }
  return { type: "none" };
}
