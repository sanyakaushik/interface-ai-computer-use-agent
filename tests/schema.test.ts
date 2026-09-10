import { describe, expect, it } from "vitest";
import { parseArtifact } from "../src/artifact/schema.js";

function baseArtifact() {
  return {
    schemaVersion: 1,
    id: "test-capability",
    name: "Test Capability",
    description: "A test capability.",
    capabilityVersion: 1,
    status: "draft",
    target: {
      appId: "riverside-servicing-console",
      vendorProduct: "AcmeCore Servicing UI",
      vendorVersion: "1.0",
      baseUrlPattern: "http://localhost:4000",
    },
    inputParams: [{ name: "memberId", type: "string", required: true, sensitive: false, description: "Member ID." }],
    outputs: [{ name: "savingsBalance", type: "string", description: "Savings balance.", sourceStepId: "step-2" }],
    steps: [
      { id: "step-1", action: "navigate", description: "Go to app", inputBinding: { kind: "literal", value: "http://localhost:4000" }, timeoutMs: 5000 },
      {
        id: "step-2",
        action: "extract",
        description: "Read balance",
        extractAs: "savingsBalance",
        target: { candidates: [{ strategy: "labelledValue", value: "Savings Balance", confidence: 0.8 }], riskLevel: "safe" },
        timeoutMs: 5000,
      },
    ],
    successCheckpoint: { strategy: "urlMatches", value: "/members/.*" },
    provenance: { discoveryRunId: "discovery-1", recordedAt: new Date().toISOString() },
  };
}

describe("CapabilityArtifact schema", () => {
  it("accepts a well-formed artifact", () => {
    expect(() => parseArtifact(baseArtifact())).not.toThrow();
  });

  it("rejects an artifact with no steps", () => {
    const bad = { ...baseArtifact(), steps: [] };
    expect(() => parseArtifact(bad)).toThrow();
  });

  it("rejects an unknown schema version", () => {
    const bad = { ...baseArtifact(), schemaVersion: 2 };
    expect(() => parseArtifact(bad)).toThrow();
  });

  it("rejects a step with zero locator candidates", () => {
    const bad = baseArtifact();
    bad.steps[1]!.target!.candidates = [];
    expect(() => parseArtifact(bad)).toThrow();
  });

  it("round-trips through JSON serialization", () => {
    const artifact = parseArtifact(baseArtifact());
    const roundTripped = parseArtifact(JSON.parse(JSON.stringify(artifact)));
    expect(roundTripped).toEqual(artifact);
  });

  it("defaults overrides to an empty array when omitted", () => {
    const artifact = parseArtifact(baseArtifact());
    expect(artifact.overrides).toEqual([]);
  });

  it("accepts a tenant override with a step-specific candidate and a different origin", () => {
    const withOverride = {
      ...baseArtifact(),
      overrides: [
        {
          tenantId: "lakeside",
          baseUrlPattern: "http://localhost:4001",
          stepOverrides: {
            "step-2": { candidates: [{ strategy: "role+name", role: "button", value: "Find Member", confidence: 0.95 }] },
          },
        },
      ],
    };
    const artifact = parseArtifact(withOverride);
    expect(artifact.overrides).toHaveLength(1);
    expect(artifact.overrides[0]!.stepOverrides["step-2"]!.candidates[0]!.value).toBe("Find Member");
  });

  it("rejects a tenant override whose step candidates array is empty", () => {
    const bad = {
      ...baseArtifact(),
      overrides: [{ tenantId: "lakeside", stepOverrides: { "step-2": { candidates: [] } } }],
    };
    expect(() => parseArtifact(bad)).toThrow();
  });
});
