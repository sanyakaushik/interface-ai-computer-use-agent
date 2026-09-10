// The Capability Artifact: the reusable, versioned, agent-invocable contract produced by a
// successful discovery run and consumed by the deterministic replay engine. This is the focal
// schema of the system (see REPORT.md #2) — it is deliberately decoupled from the raw LLM
// transcript (see /evidence/<runId>/transcript.jsonl for that).
import { z } from "zod";

export const LocatorStrategy = z.enum(["role+name", "text", "cssPath", "labelledValue"]);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

// Ranked locator candidates. Replay tries them in array order — role+name first (survives markup
// rewrites since it targets accessibility semantics), text as a looser fallback, cssPath last
// (most brittle; only present when the discovery run captured no more robust anchor).
export const LocatorCandidate = z.object({
  strategy: LocatorStrategy,
  role: z.string().optional(), // e.g. "button", "textbox", "link" (used with role+name)
  value: z.string(), // accessible name, visible text, or CSS path depending on strategy
  confidence: z.number().min(0).max(1),
});
export type LocatorCandidate = z.infer<typeof LocatorCandidate>;

export const RiskLevel = z.enum(["safe", "irreversible"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const StepAction = z.enum(["navigate", "click", "type", "selectOption", "waitFor", "extract"]);
export type StepAction = z.infer<typeof StepAction>;

// A checkpoint asserts that a step actually produced the state we expect, rather than assuming
// the action worked. Checked by the replay engine immediately after the step executes.
export const Checkpoint = z.object({
  strategy: z.enum(["urlMatches", "textVisible", "elementVisible"]),
  value: z.string(), // regex source for urlMatches, literal/substring for textVisible, locator value for elementVisible
});
export type Checkpoint = z.infer<typeof Checkpoint>;

// Where a step's action value comes from: a caller-supplied input parameter (by name) or a
// literal value baked in at discovery time (e.g. a fixed dropdown selection).
export const InputBinding = z.union([
  z.object({ kind: z.literal("param"), paramName: z.string() }),
  z.object({ kind: z.literal("literal"), value: z.string() }),
]);
export type InputBinding = z.infer<typeof InputBinding>;

export const ArtifactStep = z.object({
  id: z.string(),
  action: StepAction,
  description: z.string(), // human-readable, for reviewers
  target: z
    .object({
      candidates: z.array(LocatorCandidate).min(1),
      riskLevel: RiskLevel,
      // Which frame this target lives in: a regex (parameterized like a checkpoint) matched
      // against a live frame's path+query. Undefined means the main document — most steps.
      // Present for steps recorded inside an embedded <iframe> (see REPORT.md #4's legacy-surface
      // discussion); lets replay find the right frame before resolving locator candidates.
      frame: z.string().optional(),
    })
    .optional(), // navigate/waitFor steps may have no element target
  inputBinding: InputBinding.optional(), // for type/selectOption/navigate(url) steps
  extractAs: z.string().optional(), // for extract steps: which output field this populates
  checkpoint: Checkpoint.optional(),
  timeoutMs: z.number().int().positive().default(5000),
});
export type ArtifactStep = z.infer<typeof ArtifactStep>;

export const InputParam = z.object({
  name: z.string(),
  type: z.enum(["string", "number"]),
  required: z.boolean().default(true),
  sensitive: z.boolean().default(false), // never logged/persisted in cleartext if true
  description: z.string(),
});
export type InputParam = z.infer<typeof InputParam>;

export const OutputField = z.object({
  name: z.string(),
  type: z.enum(["string", "number"]),
  description: z.string(),
  sourceStepId: z.string(), // which step's `extract` produced this
});
export type OutputField = z.infer<typeof OutputField>;

// The multi-tenant / heterogeneity seam (see REPORT.md #4): an artifact targets a vendor
// product + version pattern, not a single tenant's literal URL. `baseUrlPattern` is filled in
// per-invocation (or per-tenant config) at replay time.
export const ArtifactTarget = z.object({
  appId: z.string(), // logical app identifier, e.g. "riverside-servicing-console"
  vendorProduct: z.string(), // e.g. "AcmeCore Servicing UI"
  vendorVersion: z.string(), // e.g. "1.0"
  baseUrlPattern: z.string(), // e.g. "http://localhost:4000" or "https://{tenant}.acmecore.example"
});
export type ArtifactTarget = z.infer<typeof ArtifactTarget>;

export const ArtifactStatus = z.enum(["draft", "approved"]);
export type ArtifactStatus = z.infer<typeof ArtifactStatus>;

// Cross-tenant reuse (spec 3.7, REPORT.md #4): hundreds of tenants can run the same
// vendorProduct/vendorVersion configured, branded, or (occasionally) versioned differently — one
// tenant's servicing console might render a control with a different label than another's. A
// TenantOverride lets that difference be captured as a small, reviewed diff on top of the base
// artifact — a per-step, per-tenant candidate to try *first* — rather than re-recording the whole
// capability per tenant. `baseUrlPattern` lets a tenant's actual instance live at a different
// origin than the one discovery was recorded against.
export const TenantOverride = z.object({
  tenantId: z.string(),
  baseUrlPattern: z.string().optional(),
  stepOverrides: z.record(z.string(), z.object({ candidates: z.array(LocatorCandidate).min(1) })).default({}),
});
export type TenantOverride = z.infer<typeof TenantOverride>;

export const CapabilityArtifact = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  capabilityVersion: z.number().int().positive(),
  status: ArtifactStatus,
  target: ArtifactTarget,
  inputParams: z.array(InputParam),
  outputs: z.array(OutputField),
  steps: z.array(ArtifactStep).min(1),
  successCheckpoint: Checkpoint,
  overrides: z.array(TenantOverride).default([]),
  provenance: z.object({
    discoveryRunId: z.string(),
    recordedAt: z.string(), // ISO timestamp
  }),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifact>;

export function parseArtifact(json: unknown): CapabilityArtifact {
  return CapabilityArtifact.parse(json);
}
