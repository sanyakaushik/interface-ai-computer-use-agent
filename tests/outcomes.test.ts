import { describe, expect, it } from "vitest";
import { classifyPageText, type OutcomeRules } from "../src/replay/outcomes.js";

const rules: OutcomeRules = {
  businessOutcomes: [
    { code: "MEMBER_NOT_FOUND", textIncludes: "No member found with ID", message: "No member exists." },
    { code: "VALIDATION_ERROR", textIncludes: "Validation error:", message: "Validation failed." },
  ],
  recoverable: [{ code: "SESSION_EXPIRED_RETRY", textIncludes: "Session Expired", recovery: "renavigate-once" }],
};

describe("outcome classification", () => {
  it("classifies a not-found page as a business outcome", () => {
    const result = classifyPageText(rules, 'No member found with ID "00000".');
    expect(result).toEqual({ type: "business_outcome", code: "MEMBER_NOT_FOUND", message: "No member exists." });
  });

  it("classifies a validation error page as a business outcome", () => {
    const result = classifyPageText(rules, "Validation error: Initial deposit must be at least $25.00.");
    expect(result.type).toBe("business_outcome");
  });

  it("classifies a session-expired page as recoverable", () => {
    const result = classifyPageText(rules, "Session Expired. Please log in again.");
    expect(result).toEqual({ type: "recoverable", code: "SESSION_EXPIRED_RETRY", recovery: "renavigate-once" });
  });

  it("classifies ordinary success content as none", () => {
    const result = classifyPageText(rules, "Member Detail. Savings Balance: $4821.13");
    expect(result).toEqual({ type: "none" });
  });

  it("prefers a business outcome over a recoverable match when both patterns are present", () => {
    const result = classifyPageText(rules, "Validation error: bad input. Session Expired also shown.");
    expect(result.type).toBe("business_outcome");
  });
});
