// A real end-to-end test of the discovery loop's mechanics — perception, tool-call execution
// against a live (headless) browser and the actual mock app, multi-tool-call handling, and
// evidence logging — without needing an ANTHROPIC_API_KEY or a network call. The loop accepts an
// injectable `ModelClient` (src/agent/loop.ts), so this test supplies a scripted fake that
// returns a fixed sequence of tool calls instead of hitting the real API. This is what closes
// the gap of "the loop's own logic is only proven by a live LLM run" — the LLM's judgment isn't
// under test here (that's what the real discovery runs under /evidence prove), but every other
// moving part in the loop is.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { runDiscovery, type ModelClient } from "../src/agent/loop.js";
import type { AllowlistConfig } from "../src/safety/allowlist.js";

const TEST_PORT = 4099;
const TEST_URL = `http://localhost:${TEST_PORT}`;

const allowlist: AllowlistConfig = {
  allowedOrigins: [TEST_URL],
  allowedActions: ["navigate", "click", "type", "selectOption", "waitFor", "extract"],
  riskyNamePatterns: ["confirm", "delete"],
};

function toolUseMessage(id: string, name: string, input: Record<string, unknown>): Anthropic.Message {
  return {
    id,
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "tool_use", id, name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Message;
}

// A scripted client: ignores whatever it's asked and returns the next response in a fixed
// queue. This is deliberately dumb — it is not standing in for LLM judgment, only proving the
// loop correctly drives Playwright, builds DiscoveryStepRecords, and logs evidence for whatever
// tool calls it's given.
function scriptedClient(responses: Anthropic.Message[]): ModelClient {
  let i = 0;
  return {
    messages: {
      create: async () => {
        if (i >= responses.length) throw new Error("scriptedClient: ran out of scripted responses");
        return responses[i++]!;
      },
    },
  };
}

let mockAppServer: import("node:http").Server;

beforeAll(async () => {
  process.env.MOCK_APP_PORT = String(TEST_PORT);
  const mod = await import(/* @vite-ignore */ `../mock-app/server.js?t=${Date.now()}`);
  mockAppServer = mod.default ?? mod.server;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (mockAppServer && typeof mockAppServer.close === "function") mockAppServer.close(() => resolve());
    else resolve();
  });
});

describe("discovery loop (scripted LLM, real browser + real mock app)", () => {
  it("drives the lookup_member_balance flow end to end and returns matching outputs and steps", async () => {
    const responses = [
      toolUseMessage("t1", "type", { ref: "0::textbox::Member ID::0", text: "12345" }),
      toolUseMessage("t2", "click", { ref: "0::button::Search::0" }),
      toolUseMessage("t3", "extract", { key: "savingsBalance", value: "$4821.13" }),
      toolUseMessage("t4", "finish_success", { summary: "Found the balance.", outputs: { savingsBalance: "$4821.13" } }),
    ];

    const result = await runDiscovery({
      goal: "Look up member 12345 and read their current savings balance.",
      targetUrl: TEST_URL,
      allowlist,
      params: { memberId: "12345" },
      modelClient: scriptedClient(responses),
      headless: true,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    expect(result.outputs).toEqual({ savingsBalance: "$4821.13" });

    // The step trace the recorder would consume: navigate, type (bound to the memberId param),
    // click, extract — in order, with the right shape for each.
    expect(result.steps.map((s) => s.action)).toEqual(["navigate", "type", "click", "extract"]);
    expect(result.steps[1]).toMatchObject({ action: "type", role: "textbox", name: "Member ID", paramName: "memberId" });
    expect(result.steps[2]).toMatchObject({ action: "click", role: "button", name: "Search" });
    expect(result.steps[3]).toMatchObject({ action: "extract", extractKey: "savingsBalance", extractLabel: "Savings Balance" });

    // Evidence was actually written, not just returned in memory.
    const logPath = `evidence/${result.runId}/log.jsonl`;
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((l) => l.event === "outcome" && l.detail.status === "success")).toBe(true);
    rmSync(`evidence/${result.runId}`, { recursive: true, force: true });
  }, 30000);

  it("handles multiple tool_use blocks in a single model response without breaking the tool_result contract", async () => {
    // A model turn that (unusually) calls two tools at once: type then click, both needing a
    // tool_result in the very next user message. This is the exact bug class that broke the
    // real discovery run earlier in this project (an Anthropic 400: "tool_use ids were found
    // without tool_result blocks") — regression-testing it directly.
    const responses: Anthropic.Message[] = [
      {
        id: "multi1",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [
          { type: "tool_use", id: "a1", name: "type", input: { ref: "0::textbox::Member ID::0", text: "12345" } },
          { type: "tool_use", id: "a2", name: "click", input: { ref: "0::button::Search::0" } },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      } as unknown as Anthropic.Message,
      toolUseMessage("t2", "extract", { key: "savingsBalance", value: "$4821.13" }),
      toolUseMessage("t3", "finish_success", { summary: "done", outputs: { savingsBalance: "$4821.13" } }),
    ];

    const result = await runDiscovery({
      goal: "Look up member 12345 and read their current savings balance.",
      targetUrl: TEST_URL,
      allowlist,
      params: { memberId: "12345" },
      modelClient: scriptedClient(responses),
      headless: true,
    });

    expect(result.status).toBe("success");
    if (result.status === "success") rmSync(`evidence/${result.runId}`, { recursive: true, force: true });
  }, 30000);

  it("stops with a failure result when the model exceeds the step budget without finishing", async () => {
    const responses = Array.from({ length: 3 }, (_, i) => toolUseMessage(`w${i}`, "waitFor", { ms: 10 }));
    const result = await runDiscovery({
      goal: "Do something that never finishes.",
      targetUrl: TEST_URL,
      allowlist,
      params: {},
      modelClient: scriptedClient(responses),
      headless: true,
      maxSteps: 3,
    });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.reason).toMatch(/max steps/i);
      rmSync(`evidence/${result.runId}`, { recursive: true, force: true });
    }
  }, 30000);
});
