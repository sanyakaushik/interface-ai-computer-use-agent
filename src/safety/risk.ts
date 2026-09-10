// Risk classification (spec 3.4): distinguishes safe/reversible actions from risky/irreversible
// ones. We classify conservatively at record time (any interactive element whose accessible
// name matches a configured pattern is treated as irreversible) and enforce conservatively at
// replay time (irreversible steps require both an approved artifact and an explicit per-invocation
// confirmation — never executed silently).
import type { AllowlistConfig } from "./allowlist.js";
import type { CapabilityArtifact, RiskLevel } from "../artifact/schema.js";

export function classifyRisk(config: AllowlistConfig, accessibleName: string): RiskLevel {
  const lower = accessibleName.toLowerCase();
  const isRisky = config.riskyNamePatterns.some((pattern) => lower.includes(pattern.toLowerCase()));
  return isRisky ? "irreversible" : "safe";
}

// A second, independent risk signal: what the page itself says, not just what the control is
// named. A blandly-named control ("OK", "Continue") sitting next to text that says an action
// "cannot be undone" should still be treated as irreversible — name-pattern matching alone would
// miss it entirely if the button text doesn't happen to contain a risky word. Used by the
// discovery loop at record time, in addition to (not instead of) classifyRisk.
const IRREVERSIBILITY_PHRASES = [/cannot be undone/i, /can(?:'|no)t be reversed/i, /this action is permanent/i, /irreversible/i];

export function pageTextSignalsIrreversibility(visibleText: string): boolean {
  return IRREVERSIBILITY_PHRASES.some((re) => re.test(visibleText));
}

export interface ApprovalGateResult {
  allowed: boolean;
  reason?: string;
}

// Called once before replay executes any irreversible step. `confirmIrreversible` models an
// explicit, per-invocation supervisor confirmation (e.g. a CLI flag or a field the calling agent
// must set) — separate from the artifact's own draft/approved lifecycle state.
export function checkApprovalGate(artifact: CapabilityArtifact, confirmIrreversible: boolean): ApprovalGateResult {
  const hasIrreversibleStep = artifact.steps.some((s) => s.target?.riskLevel === "irreversible");
  if (!hasIrreversibleStep) return { allowed: true };

  if (artifact.status !== "approved") {
    return {
      allowed: false,
      reason: `Artifact "${artifact.id}" contains an irreversible step but is not approved (status="${artifact.status}").`,
    };
  }
  if (!confirmIrreversible) {
    return {
      allowed: false,
      reason: `Artifact "${artifact.id}" contains an irreversible step; replay requires explicit --confirm-irreversible.`,
    };
  }
  return { allowed: true };
}
