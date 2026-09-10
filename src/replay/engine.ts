// Deterministic replay (spec 3.3): the production execution path an AI agent triggers. No LLM
// decisions here — every step's target and expected outcome came from the recorded artifact.
import type { Page } from "playwright";
import { launchSession } from "../browser/session.js";
import { resolveLocator, LocatorResolutionError, type LocatorRoot } from "./locator.js";
import { resolveExtractedValue } from "./extraction.js";
import { classifyPageText, type OutcomeRules } from "./outcomes.js";
import { assertOriginAllowed, assertActionAllowed, AllowlistViolation, type AllowlistConfig } from "../safety/allowlist.js";
import { checkApprovalGate } from "../safety/risk.js";
import { redactParams } from "../safety/redaction.js";
import { EvidenceLogger, newRunId } from "../logging/logger.js";
import { raiseIntervention, waitForResume, operatorUrl } from "../handoff/client.js";
import type { ArtifactStep, CapabilityArtifact, LocatorCandidate, TenantOverride } from "../artifact/schema.js";

export type ReplayResult =
  | { status: "success"; runId: string; outputs: Record<string, string> }
  | { status: "business_outcome"; runId: string; code: string; message: string }
  | { status: "awaiting_approval"; runId: string; reason: string }
  | { status: "escalated"; runId: string; interventionId: string }
  | { status: "failure"; runId: string; stepId: string; expected: string; observed: string; evidencePath?: string };

export interface ReplayOptions {
  artifact: CapabilityArtifact;
  params: Record<string, string>;
  allowlist: AllowlistConfig;
  outcomeRules: OutcomeRules;
  confirmIrreversible?: boolean;
  escalateOnFailure?: boolean;
  headless?: boolean;
  // Cross-tenant reuse (REPORT.md #4): replay this artifact against a specific tenant's
  // instance, applying that tenant's reviewed candidate/origin overrides (if any) on top of the
  // base artifact rather than requiring a separately-recorded artifact per tenant.
  tenantId?: string;
}

export async function runReplay(opts: ReplayOptions): Promise<ReplayResult> {
  const { artifact } = opts;
  const runId = newRunId("replay");
  const logger = new EvidenceLogger(runId, "replay");
  const sensitiveNames = new Set(artifact.inputParams.filter((p) => p.sensitive).map((p) => p.name));

  logger.log(0, "start", { capability: artifact.id, capabilityVersion: artifact.capabilityVersion, params: redactParams(opts.params, sensitiveNames) });

  const paramError = validateParams(artifact, opts.params);
  if (paramError) {
    logger.log(0, "error", { reason: paramError });
    return { status: "failure", runId, stepId: "params", expected: "valid input parameters", observed: paramError };
  }

  const approval = checkApprovalGate(artifact, opts.confirmIrreversible ?? false);
  if (!approval.allowed) {
    logger.log(0, "awaiting_approval", { reason: approval.reason });
    return { status: "awaiting_approval", runId, reason: approval.reason! };
  }

  const tenantOverride = opts.tenantId ? artifact.overrides.find((o) => o.tenantId === opts.tenantId) : undefined;
  if (opts.tenantId) {
    logger.log(0, "tenant", { tenantId: opts.tenantId, overrideFound: Boolean(tenantOverride), baseUrlOverride: tenantOverride?.baseUrlPattern });
  }

  const session = await launchSession({ headless: opts.headless ?? true });
  const { page } = session;
  const outputs: Record<string, string> = {};

  try {
    for (const step of artifact.steps) {
      const stepResult = await executeStep(page, step, opts, logger, artifact, tenantOverride);

      if (stepResult.kind === "extracted") {
        outputs[stepResult.key] = stepResult.value;
        continue;
      }
      if (stepResult.kind === "business_outcome") {
        logger.log(step.id, "outcome", { status: "business_outcome", code: stepResult.code });
        return { status: "business_outcome", runId, code: stepResult.code, message: stepResult.message };
      }
      if (stepResult.kind === "failure") {
        const shot = await safeScreenshot(page);
        const evidencePath = shot ? logger.saveScreenshot(`failure-${step.id}`, shot) : undefined;
        logger.log(step.id, "error", { expected: stepResult.expected, observed: stepResult.observed, evidencePath });

        if (opts.escalateOnFailure) {
          const intervention = await raiseIntervention({
            runId,
            kind: "replay",
            capabilityOrGoal: artifact.id,
            currentStep: step.id,
            reason: `${stepResult.expected} — observed: ${stepResult.observed}`,
            screenshotPath: evidencePath?.replace(/^evidence[\\/]/, ""),
          });
          console.log(`\n[replay] Escalated. Operator console: ${operatorUrl()}  (intervention ${intervention.id})`);
          try {
            await waitForResume(intervention.id);
            logger.log(step.id, "resumed", {});
            continue; // re-check next step; a human may have manually advanced the live session
          } catch (err) {
            logger.log(step.id, "abandoned", { error: String(err) });
            return { status: "escalated", runId, interventionId: intervention.id };
          }
        }

        return { status: "failure", runId, stepId: step.id, expected: stepResult.expected, observed: stepResult.observed, evidencePath };
      }
      // kind === "ok": fall through to next step
    }

    // An escalation resume can move execution past a step whose result never actually landed
    // (e.g. an extraction that failed and was overridden by a human, or a step skipped
    // entirely) — so success is never declared just because we reached the end of the step
    // list. Every output the artifact promises the caller must actually have been produced.
    const missingOutputs = artifact.outputs.map((o) => o.name).filter((name) => !(name in outputs));
    if (missingOutputs.length > 0) {
      logger.log("done", "error", { expected: "all declared outputs produced", observed: `missing: ${missingOutputs.join(", ")}` });
      return {
        status: "failure",
        runId,
        stepId: "outputs",
        expected: `all declared outputs produced (${artifact.outputs.map((o) => o.name).join(", ")})`,
        observed: `missing: ${missingOutputs.join(", ")}`,
      };
    }

    // Final success checkpoint verification
    const finalCheck = await verifyCheckpoint(page, artifact.successCheckpoint);
    if (!finalCheck.ok) {
      const shot = await safeScreenshot(page);
      const evidencePath = shot ? logger.saveScreenshot("failure-success-checkpoint", shot) : undefined;
      logger.log("success-checkpoint", "error", { expected: finalCheck.expected, observed: finalCheck.observed });
      return {
        status: "failure",
        runId,
        stepId: "success-checkpoint",
        expected: finalCheck.expected,
        observed: finalCheck.observed,
        evidencePath,
      };
    }

    logger.log("done", "outcome", { status: "success", outputs });
    return { status: "success", runId, outputs };
  } finally {
    await session.close();
  }
}

type StepOutcome =
  | { kind: "ok" }
  | { kind: "extracted"; key: string; value: string }
  | { kind: "business_outcome"; code: string; message: string }
  | { kind: "failure"; expected: string; observed: string };

async function executeStep(
  page: Page,
  step: ArtifactStep,
  opts: ReplayOptions,
  logger: EvidenceLogger,
  artifact: CapabilityArtifact,
  tenantOverride: TenantOverride | undefined
): Promise<StepOutcome> {
  try {
    assertActionAllowed(opts.allowlist, step.action);
  } catch (err) {
    if (err instanceof AllowlistViolation) return { kind: "failure", expected: "action permitted by allowlist", observed: err.message };
    throw err;
  }

  logger.log(step.id, "act", { action: step.action, description: step.description, tenantId: opts.tenantId });

  // A tenant override contributes step-specific candidates to try *first* (e.g. this tenant's
  // instance renamed a button) — the base artifact's own candidates remain as fallback, so an
  // override only needs to capture what's actually different for that tenant.
  const candidatesFor = (target: { candidates: LocatorCandidate[] } | undefined): LocatorCandidate[] => {
    const overrideCandidates = tenantOverride?.stepOverrides[step.id]?.candidates ?? [];
    return [...overrideCandidates, ...(target?.candidates ?? [])];
  };

  if (step.action === "extract") {
    if (!step.target) return { kind: "failure", expected: "extraction target recorded", observed: "no target on step" };
    try {
      const root = await resolveFrameRoot(page, step.target.frame);
      const value = await resolveExtractedValue(root, candidatesFor(step.target));
      return { kind: "extracted", key: step.extractAs!, value };
    } catch (err) {
      return { kind: "failure", expected: `extractable value for "${step.extractAs}"`, observed: (err as Error).message };
    }
  }

  const rawValue = resolveInputValue(step, opts.params);
  const value =
    step.action === "navigate" && rawValue ? rewriteOriginForTenant(rawValue, artifact.target.baseUrlPattern, tenantOverride) : rawValue;

  if (step.action === "navigate") {
    try {
      assertOriginAllowed(opts.allowlist, value!);
      await page.goto(value!, { timeout: step.timeoutMs, waitUntil: "domcontentloaded" });
    } catch (err) {
      if (err instanceof AllowlistViolation) return { kind: "failure", expected: "origin permitted by allowlist", observed: err.message };
      return { kind: "failure", expected: `navigation to ${value}`, observed: (err as Error).message };
    }
  } else if (step.action === "waitFor") {
    await page.waitForTimeout(Math.min(Number(value ?? "0"), 10_000));
  } else {
    if (!step.target) return { kind: "failure", expected: "a locator target", observed: "step has no target" };
    let resolution;
    try {
      const root = await resolveFrameRoot(page, step.target.frame);
      resolution = await resolveLocator(root, candidatesFor(step.target));
    } catch (err) {
      if (err instanceof LocatorResolutionError) {
        return { kind: "failure", expected: step.description, observed: err.message };
      }
      return { kind: "failure", expected: step.description, observed: (err as Error).message };
    }
    try {
      if (step.action === "click") await resolution.locator.click({ timeout: step.timeoutMs });
      else if (step.action === "type") await resolution.locator.fill(value ?? "", { timeout: step.timeoutMs });
      else if (step.action === "selectOption") await resolution.locator.selectOption(value ?? "", { timeout: step.timeoutMs });
    } catch (err) {
      return { kind: "failure", expected: step.description, observed: (err as Error).message };
    }
  }

  // After acting, check for a known business outcome or recoverable condition before trusting
  // the step's own checkpoint (a validation error, "not found", or denial is not a locator
  // failure — it's a legitimate result the caller needs to see).
  const visibleText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  const classified = classifyPageText(opts.outcomeRules, visibleText);
  if (classified.type === "business_outcome") {
    return { kind: "business_outcome", code: classified.code, message: classified.message };
  }
  if (classified.type === "recoverable" && classified.recovery === "renavigate-once") {
    await page.goto(page.url(), { timeout: step.timeoutMs, waitUntil: "domcontentloaded" }).catch(() => undefined);
    const retryText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const retryClassified = classifyPageText(opts.outcomeRules, retryText);
    if (retryClassified.type === "business_outcome") {
      return { kind: "business_outcome", code: retryClassified.code, message: retryClassified.message };
    }
    if (retryClassified.type !== "none") {
      return { kind: "failure", expected: "recoverable condition to clear after one retry", observed: `still showing: ${classified.code}` };
    }
  }

  if (step.checkpoint) {
    const result = await verifyCheckpoint(page, step.checkpoint);
    if (!result.ok) return { kind: "failure", expected: result.expected, observed: result.observed };
  }

  return { kind: "ok" };
}

// Finds the frame (main document or an embedded <iframe>) whose live URL matches the step's
// recorded, parameterized `frame` pattern — the replay-side counterpart of
// perception.ts's frame-walking during discovery. Polls briefly because an iframe's Frame object
// can appear a beat after its parent document finishes loading. No pattern means "the main
// document," which is the overwhelmingly common case and costs nothing extra to check.
export async function resolveFrameRoot(page: Page, framePattern: string | undefined, timeoutMs = 3000): Promise<LocatorRoot> {
  if (!framePattern) return page;
  const regex = new RegExp(framePattern);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const frame of page.frames()) {
      try {
        const u = new URL(frame.url());
        if (regex.test(u.pathname + u.search)) return frame;
      } catch {
        // an about:blank or not-yet-navigated frame — not a match, keep looking
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`No frame found matching /${framePattern}/ (frames present: ${page.frames().map((f) => f.url()).join(", ") || "none"}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function resolveInputValue(step: ArtifactStep, params: Record<string, string>): string | undefined {
  if (!step.inputBinding) return undefined;
  if (step.inputBinding.kind === "literal") return step.inputBinding.value;
  return params[step.inputBinding.paramName];
}

// Every navigate step in a discovered artifact carries a literal URL under the base
// (discovery-time) origin. A tenant override may point at a different origin entirely (a
// separate instance of the same vendor product) — this swaps just the origin, preserving
// whatever path/query the base artifact recorded.
function rewriteOriginForTenant(url: string, baseUrlPattern: string, tenantOverride: TenantOverride | undefined): string {
  if (!tenantOverride?.baseUrlPattern) return url;
  try {
    const base = new URL(baseUrlPattern).origin;
    if (!url.startsWith(base)) return url;
    return tenantOverride.baseUrlPattern + url.slice(base.length);
  } catch {
    return url;
  }
}

async function verifyCheckpoint(page: Page, checkpoint: ArtifactStep["checkpoint"]): Promise<{ ok: boolean; expected: string; observed: string }> {
  if (!checkpoint) return { ok: true, expected: "", observed: "" };
  if (checkpoint.strategy === "urlMatches") {
    const current = page.url();
    const pathAndQuery = (() => {
      try {
        const u = new URL(current);
        return u.pathname + u.search;
      } catch {
        return current;
      }
    })();
    const regex = new RegExp(checkpoint.value);
    return { ok: regex.test(pathAndQuery), expected: `URL path matching /${checkpoint.value}/`, observed: current };
  }
  if (checkpoint.strategy === "textVisible") {
    const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    return { ok: text.includes(checkpoint.value), expected: `page text containing "${checkpoint.value}"`, observed: text.slice(0, 300) };
  }
  // elementVisible
  try {
    await page.locator(checkpoint.value).first().waitFor({ state: "visible", timeout: 2000 });
    return { ok: true, expected: `element "${checkpoint.value}" visible`, observed: "visible" };
  } catch {
    return { ok: false, expected: `element "${checkpoint.value}" visible`, observed: "not found" };
  }
}

function validateParams(artifact: CapabilityArtifact, params: Record<string, string>): string | undefined {
  for (const p of artifact.inputParams) {
    if (p.required && !(p.name in params)) return `Missing required parameter "${p.name}".`;
    if (p.name in params && p.type === "number" && Number.isNaN(Number(params[p.name]))) {
      return `Parameter "${p.name}" must be a number, got "${params[p.name]}".`;
    }
  }
  return undefined;
}

async function safeScreenshot(page: Page): Promise<Buffer | undefined> {
  try {
    return await page.screenshot();
  } catch {
    return undefined;
  }
}
