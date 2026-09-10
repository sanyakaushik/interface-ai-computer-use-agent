// Turns a successful discovery transcript into a decoupled, versioned Capability artifact
// (spec 3.2). This is the only place raw discovery output is translated into the replay
// contract — the replay engine never looks at a transcript.
import type { AllowlistConfig } from "../safety/allowlist.js";
import { classifyRisk } from "../safety/risk.js";
import { looksSensitive } from "../safety/redaction.js";
import type { DiscoveryStepRecord } from "../agent/loop.js";
import type {
  ArtifactStep,
  CapabilityArtifact,
  Checkpoint,
  InputBinding,
  InputParam,
  LocatorCandidate,
  OutputField,
} from "./schema.js";

export interface RecordArtifactInput {
  id: string;
  name: string;
  description: string;
  discoveryRunId: string;
  target: CapabilityArtifact["target"];
  params: Record<string, string>;
  steps: DiscoveryStepRecord[];
  finalSummary: string;
}

export function buildArtifact(allowlist: AllowlistConfig, input: RecordArtifactInput): CapabilityArtifact {
  const inputParams: InputParam[] = Object.entries(input.params).map(([name, value]) => ({
    name,
    type: /^-?\d+(\.\d+)?$/.test(value) ? "number" : "string",
    required: true,
    sensitive: looksSensitive(value) || /ssn|password|secret|token/i.test(name),
    description: `Input value for "${name}".`,
  }));

  const outputs: OutputField[] = [];
  const steps: ArtifactStep[] = [];
  let previousUrl: string | undefined;

  input.steps.forEach((record, index) => {
    const id = `step-${index + 1}`;

    if (record.action === "extract") {
      if (!outputs.some((o) => o.name === record.extractKey)) {
        outputs.push({
          name: record.extractKey!,
          type: "string",
          description: `Value extracted at ${id} (e.g. "${record.literalValue}").`,
          sourceStepId: id,
        });
      }
      const target = record.extractLabel
        ? {
            candidates: [{ strategy: "labelledValue" as const, value: record.extractLabel, confidence: 0.8 }],
            riskLevel: "safe" as const,
            frame: record.frameUrl ? pathAndQueryPattern(record.frameUrl, input.params) : undefined,
          }
        : undefined;
      steps.push({ id, action: "extract", description: record.description, extractAs: record.extractKey, target, timeoutMs: 5000 });
      return;
    }

    const inputBinding: InputBinding | undefined =
      record.paramName != null
        ? { kind: "param", paramName: record.paramName }
        : record.literalValue != null
          ? { kind: "literal", value: record.literalValue }
          : undefined;

    // Two independent, conservative signals feed risk classification: the control's own name
    // (safety/risk.ts's pattern match) and whatever the page said immediately before it was
    // clicked (record.irreversiblePhraseDetected — e.g. "this action cannot be undone" next to a
    // blandly-named "OK" button). Either one is enough to mark a step irreversible.
    const target =
      record.role && record.name
        ? {
            candidates: buildCandidates(record),
            riskLevel:
              record.irreversiblePhraseDetected || classifyRisk(allowlist, record.name) === "irreversible"
                ? ("irreversible" as const)
                : ("safe" as const),
            frame: record.frameUrl ? pathAndQueryPattern(record.frameUrl, input.params) : undefined,
          }
        : undefined;

    const checkpoint: Checkpoint | undefined =
      previousUrl && record.urlAfter !== previousUrl
        ? { strategy: "urlMatches", value: pathAndQueryPattern(record.urlAfter, input.params) }
        : undefined;

    steps.push({
      id,
      action: record.action,
      description: record.description,
      target,
      inputBinding,
      checkpoint,
      timeoutMs: 5000,
    });
    previousUrl = record.urlAfter;
  });

  const lastStepWithUrl = [...input.steps].reverse().find((s) => s.urlAfter);
  const successCheckpoint: Checkpoint = {
    strategy: "urlMatches",
    value: pathAndQueryPattern(lastStepWithUrl?.urlAfter ?? input.target.baseUrlPattern, input.params),
  };

  return {
    schemaVersion: 1,
    id: input.id,
    name: input.name,
    description: input.description,
    capabilityVersion: 1,
    status: "draft",
    target: input.target,
    inputParams,
    outputs,
    steps,
    successCheckpoint,
    overrides: [],
    provenance: { discoveryRunId: input.discoveryRunId, recordedAt: new Date().toISOString() },
  };
}

function buildCandidates(record: DiscoveryStepRecord): LocatorCandidate[] {
  const candidates: LocatorCandidate[] = [
    { strategy: "role+name", role: record.role, value: record.name!, confidence: 0.9 },
  ];
  if (record.role === "button" || record.role === "link") {
    candidates.push({ strategy: "text", value: record.name!, confidence: 0.5 });
  }
  if (record.cssPath) {
    candidates.push({ strategy: "cssPath", value: record.cssPath, confidence: 0.2 });
  }
  return candidates;
}

function pathAndQuery(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

// Builds a checkpoint regex from a recorded URL's path+query, but generalizes it: any recorded
// input param value that appears in the URL (e.g. a member ID in "/members/12345") is replaced
// with a wildcard rather than baked in literally — otherwise a checkpoint recorded against one
// invocation's params would only ever match that same invocation on replay.
function pathAndQueryPattern(url: string, params: Record<string, string>): string {
  let escaped = escapeRegex(pathAndQuery(url));
  for (const value of Object.values(params)) {
    if (!value) continue;
    const escapedValue = escapeRegex(value);
    escaped = escaped.split(escapedValue).join("[^/]+");
  }
  return escaped;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
