import { describe, expect, it } from "vitest";
import { assertOriginAllowed, assertActionAllowed, AllowlistViolation, type AllowlistConfig } from "../src/safety/allowlist.js";
import { classifyRisk, checkApprovalGate, pageTextSignalsIrreversibility } from "../src/safety/risk.js";
import { redactParams, redactText, looksSensitive } from "../src/safety/redaction.js";
import type { CapabilityArtifact } from "../src/artifact/schema.js";

const allowlist: AllowlistConfig = {
  allowedOrigins: ["http://localhost:4000"],
  allowedActions: ["navigate", "click", "type"],
  riskyNamePatterns: ["confirm", "delete"],
};

describe("allowlist enforcement", () => {
  it("allows an in-allowlist origin", () => {
    expect(() => assertOriginAllowed(allowlist, "http://localhost:4000/members/1")).not.toThrow();
  });

  it("blocks an out-of-allowlist origin", () => {
    expect(() => assertOriginAllowed(allowlist, "http://evil.example.com")).toThrow(AllowlistViolation);
  });

  it("blocks a disallowed action type", () => {
    expect(() => assertActionAllowed(allowlist, "extract")).toThrow(AllowlistViolation);
  });

  it("allows an allowlisted action type", () => {
    expect(() => assertActionAllowed(allowlist, "click")).not.toThrow();
  });
});

describe("risk classification", () => {
  it("classifies a confirm button as irreversible", () => {
    expect(classifyRisk(allowlist, "Confirm — Open Sub-Account")).toBe("irreversible");
  });

  it("classifies a plain search button as safe", () => {
    expect(classifyRisk(allowlist, "Search")).toBe("safe");
  });

  it("detects irreversibility from page text even when the control name gives no hint", () => {
    // The scenario this closes: a blandly-named "OK" button that classifyRisk alone would call
    // safe, sitting on a page that explicitly warns the action is permanent.
    expect(classifyRisk(allowlist, "OK")).toBe("safe");
    expect(pageTextSignalsIrreversibility("This action cannot be undone. Click OK to proceed.")).toBe(true);
  });

  it("does not flag ordinary page text as irreversible", () => {
    expect(pageTextSignalsIrreversibility("Member Detail. Savings Balance: $4821.13")).toBe(false);
  });

  it("recognizes multiple phrasings of irreversibility", () => {
    expect(pageTextSignalsIrreversibility("This can't be reversed once submitted.")).toBe(true);
    expect(pageTextSignalsIrreversibility("Warning: this action is permanent.")).toBe(true);
  });
});

function artifactWithRisk(riskLevel: "safe" | "irreversible", status: "draft" | "approved"): CapabilityArtifact {
  return {
    schemaVersion: 1,
    id: "a",
    name: "A",
    description: "d",
    capabilityVersion: 1,
    status,
    target: { appId: "x", vendorProduct: "x", vendorVersion: "1", baseUrlPattern: "http://localhost:4000" },
    inputParams: [],
    outputs: [],
    steps: [
      {
        id: "step-1",
        action: "click",
        description: "d",
        target: { candidates: [{ strategy: "role+name", role: "button", value: "Confirm", confidence: 0.9 }], riskLevel },
        timeoutMs: 5000,
      },
    ],
    successCheckpoint: { strategy: "urlMatches", value: ".*" },
    overrides: [],
    provenance: { discoveryRunId: "r1", recordedAt: new Date().toISOString() },
  };
}

describe("approval gate", () => {
  it("allows a safe-only artifact regardless of status", () => {
    expect(checkApprovalGate(artifactWithRisk("safe", "draft"), false).allowed).toBe(true);
  });

  it("blocks an irreversible artifact that is still draft", () => {
    expect(checkApprovalGate(artifactWithRisk("irreversible", "draft"), true).allowed).toBe(false);
  });

  it("blocks an approved irreversible artifact without explicit confirmation", () => {
    expect(checkApprovalGate(artifactWithRisk("irreversible", "approved"), false).allowed).toBe(false);
  });

  it("allows an approved irreversible artifact with explicit confirmation", () => {
    expect(checkApprovalGate(artifactWithRisk("irreversible", "approved"), true).allowed).toBe(true);
  });
});

describe("redaction", () => {
  it("masks params explicitly marked sensitive", () => {
    const out = redactParams({ memberId: "12345", ssn: "123-45-6789" }, new Set(["ssn"]));
    expect(out.memberId).toBe("12345");
    expect(out.ssn).toBe("***redacted***");
  });

  it("masks SSN-shaped values even when not explicitly flagged", () => {
    expect(looksSensitive("123-45-6789")).toBe(true);
    const out = redactParams({ notes: "123-45-6789" }, new Set());
    expect(out.notes).toBe("***redacted***");
  });

  it("masks long digit runs (account/card-shaped) in free text", () => {
    const redacted = redactText("Card on file: 4111111111111111 thanks");
    expect(redacted).not.toContain("4111111111111111");
  });

  it("leaves ordinary business identifiers untouched", () => {
    const out = redactParams({ memberId: "12345" }, new Set());
    expect(out.memberId).toBe("12345");
  });
});
