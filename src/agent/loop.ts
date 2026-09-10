// The goal-driven discovery loop (spec 3.1): observe -> decide (LLM tool-use call) -> act,
// against the live mock-app surface, until finish_success/report_stuck/a stopping condition.
// The raw transcript this produces is evidence, not the artifact — `recorder.ts` derives the
// decoupled, replayable Capability artifact from the `steps` this function returns.
import Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";
import { launchSession } from "../browser/session.js";
import { perceive, formatPerceptionForModel, findLabelForValue, frameUrlForIndex, parseRef } from "./perception.js";
import { doClick, doType, doSelectOption, doNavigate, captureCssPath } from "./actions.js";
import { DISCOVERY_TOOLS } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";
import { assertOriginAllowed, assertActionAllowed, AllowlistViolation, type AllowlistConfig } from "../safety/allowlist.js";
import { pageTextSignalsIrreversibility } from "../safety/risk.js";
import { EvidenceLogger, newRunId } from "../logging/logger.js";
import { raiseIntervention, waitForResume, operatorUrl } from "../handoff/client.js";
import { withRetry } from "./retry.js";

// The subset of the Anthropic SDK client this loop actually calls. Accepting this narrower
// shape (rather than requiring a real `Anthropic` instance) is what makes the loop unit-testable
// end to end without an API key — see tests/loop.test.ts, which injects a scripted fake here.
export interface ModelClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface DiscoveryStepRecord {
  action: "navigate" | "click" | "type" | "selectOption" | "waitFor" | "extract";
  description: string;
  role?: string;
  name?: string;
  cssPath?: string;
  literalValue?: string;
  paramName?: string;
  extractKey?: string;
  extractLabel?: string;
  irreversiblePhraseDetected?: boolean;
  frameUrl?: string; // set when the target element lives inside an embedded <iframe>, not the main document
  urlAfter: string;
}

export type DiscoveryResult =
  | { status: "success"; runId: string; summary: string; outputs: Record<string, unknown>; steps: DiscoveryStepRecord[] }
  | { status: "escalated"; runId: string; interventionId: string; reason: string }
  | { status: "failure"; runId: string; reason: string };

export interface DiscoveryOptions {
  goal: string;
  targetUrl: string;
  allowlist: AllowlistConfig;
  params: Record<string, string>; // named values used both to drive the goal and to auto-parameterize steps
  maxSteps?: number;
  model?: string;
  // Injectable for testing (see tests/loop.test.ts) — defaults to a real Anthropic client.
  modelClient?: ModelClient;
  // Defaults to false (headed) — the real discovery path wants a visible window so a human can
  // take it over (spec 3.6). Tests override this to true so they run in a display-less sandbox.
  headless?: boolean;
}

export async function runDiscovery(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const runId = newRunId("discovery");
  const logger = new EvidenceLogger(runId, "discovery");
  const maxSteps = opts.maxSteps ?? 15;
  const model = opts.model ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-5";
  const anthropic: ModelClient = opts.modelClient ?? new Anthropic();

  const allowedOrigin = new URL(opts.targetUrl).origin;
  assertOriginAllowed(opts.allowlist, opts.targetUrl);

  const session = await launchSession({ headless: opts.headless ?? false });
  const { page } = session;
  const steps: DiscoveryStepRecord[] = [];
  const outputs: Record<string, unknown> = {};

  try {
    await doNavigate(page, opts.targetUrl, 10_000);
    steps.push({ action: "navigate", description: `Navigate to ${opts.targetUrl}`, literalValue: opts.targetUrl, urlAfter: page.url() });

    const system = buildSystemPrompt({ goal: opts.goal, allowedOrigin, allowlist: opts.allowlist, maxSteps });
    let perception = await perceive(page);
    logger.log(0, "observe", { url: perception.url, elementCount: perception.elements.length });

    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: formatPerceptionForModel(perception) },
          await screenshotBlock(page),
        ],
      },
    ];

    for (let stepIndex = 1; stepIndex <= maxSteps; stepIndex++) {
      const response = await withRetry(
        () =>
          anthropic.messages.create({
            model,
            max_tokens: 1024,
            system,
            tools: DISCOVERY_TOOLS,
            messages,
          }),
        {
          onRetry: (attempt, err, delayMs) => {
            logger.log(stepIndex, "retry", { attempt, error: String(err), delayMs: Math.round(delayMs) });
            console.log(`[discover] model call failed (attempt ${attempt}), retrying in ${Math.round(delayMs)}ms: ${String(err)}`);
          },
        }
      );
      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const thoughtText = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
      if (thoughtText) logger.log(stepIndex, "decide", { thought: thoughtText });

      if (toolUses.length === 0) {
        logger.log(stepIndex, "error", { reason: "Model returned no tool call." });
        return { status: "failure", runId, reason: "Model returned no tool call." };
      }
      for (const tu of toolUses) logger.log(stepIndex, "act", { tool: tu.name, input: tu.input });

      // The model is instructed to call exactly one tool per turn, but the API only requires
      // that every tool_use block in this assistant message gets a matching tool_result in the
      // next user message — so we handle the (rare) multi-tool-call case by executing each in
      // order and building a tool_result for every one of them, regardless of how many there are.
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let outcome: "continue" | "success" | "escalated_return" | "failure" = "continue";
      let failureReason = "";

      for (const toolUse of toolUses) {
        if (toolUse.name === "finish_success") {
          const input = toolUse.input as { summary: string; outputs?: Record<string, unknown> };
          Object.assign(outputs, input.outputs ?? {});
          logger.log(stepIndex, "outcome", { status: "success", outputs });
          outcome = "success";
          break;
        }

        if (toolUse.name === "report_stuck") {
          const input = toolUse.input as { reason: string };
          const shot = await page.screenshot();
          const shotPath = logger.saveScreenshot(`stuck-${stepIndex}`, shot);
          const snapshotPath = logger.saveSnapshot(`stuck-${stepIndex}`, formatPerceptionForModel(perception));
          logger.log(stepIndex, "escalate", { reason: input.reason, shotPath, snapshotPath });

          const intervention = await raiseIntervention({
            runId,
            kind: "discovery",
            capabilityOrGoal: opts.goal,
            currentStep: `step ${stepIndex}`,
            reason: input.reason,
            screenshotPath: relativeToEvidence(shotPath),
            snapshotText: formatPerceptionForModel(perception).slice(0, 2000),
          });
          console.log(`\n[discovery] Escalated. Operator console: ${operatorUrl()}  (intervention ${intervention.id})`);
          console.log(`[discovery] Take over the visible browser window directly, then click Resume.\n`);

          try {
            const resumed = await waitForResume(intervention.id);
            logger.log(stepIndex, "resumed", { humanNotes: resumed.humanNotes });
            perception = await perceive(page);
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: [
                {
                  type: "text",
                  text:
                    `A human operator took over and resumed automation. Notes: "${resumed.humanNotes ?? "(none)"}".\n` +
                    `Current state:\n${formatPerceptionForModel(perception)}`,
                },
                await screenshotBlock(page),
              ],
            });
            break; // any tool_use blocks after report_stuck in this batch are stale; move on
          } catch (err) {
            logger.log(stepIndex, "abandoned", { error: String(err) });
            return { status: "escalated", runId, interventionId: intervention.id, reason: input.reason };
          }
        }

        // Regular action tools
        let resultText: string;
        try {
          assertActionAllowed(opts.allowlist, toolUse.name);
          resultText = await executeTool(page, toolUse, opts, steps, perception.visibleText);
        } catch (err) {
          if (err instanceof AllowlistViolation) {
            logger.log(stepIndex, "error", { reason: err.message });
            outcome = "failure";
            failureReason = `Allowlist violation: ${err.message}`;
            break;
          }
          resultText = `Error executing ${toolUse.name}: ${(err as Error).message}`;
          logger.log(stepIndex, "error", { tool: toolUse.name, error: resultText });
        }

        perception = await perceive(page);
        logger.log(stepIndex, "observe", { url: perception.url, elementCount: perception.elements.length });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: [
            { type: "text", text: `${resultText}\n\nCurrent state:\n${formatPerceptionForModel(perception)}` },
            await screenshotBlock(page),
          ],
        });
      }

      if (outcome === "success") {
        const input = (toolUses.find((t) => t.name === "finish_success")!.input) as { summary: string };
        return { status: "success", runId, summary: input.summary, outputs, steps };
      }
      if (outcome === "failure") {
        return { status: "failure", runId, reason: failureReason };
      }

      messages.push({ role: "user", content: toolResults });
    }

    logger.log(maxSteps, "outcome", { status: "failure", reason: "max steps exceeded" });
    return { status: "failure", runId, reason: `Exceeded max steps (${maxSteps}) without reaching the goal.` };
  } finally {
    await session.close();
  }
}

async function executeTool(
  page: Page,
  toolUse: Anthropic.ToolUseBlock,
  opts: DiscoveryOptions,
  steps: DiscoveryStepRecord[],
  visibleTextBeforeAction: string
): Promise<string> {
  switch (toolUse.name) {
    case "click": {
      const { ref } = toolUse.input as { ref: string };
      const cssPath = await captureCssPath(page, ref);
      const irreversiblePhraseDetected = pageTextSignalsIrreversibility(visibleTextBeforeAction);
      await doClick(page, ref, 5000);
      const { frameIdx, role, name } = parseRef(ref);
      steps.push({
        action: "click",
        description: `Click ${role} "${name}"`,
        role,
        name,
        cssPath,
        irreversiblePhraseDetected,
        frameUrl: frameIdx > 0 ? await frameUrlForIndex(page, frameIdx) : undefined,
        urlAfter: page.url(),
      });
      return `Clicked ${role} "${name}".`;
    }
    case "type": {
      const { ref, text } = toolUse.input as { ref: string; text: string };
      const cssPath = await captureCssPath(page, ref);
      await doType(page, ref, text, 5000);
      const { frameIdx, role, name } = parseRef(ref);
      const paramName = matchParam(opts.params, text);
      steps.push({
        action: "type",
        description: `Type into ${role} "${name}"`,
        role,
        name,
        cssPath,
        literalValue: paramName ? undefined : text,
        paramName,
        frameUrl: frameIdx > 0 ? await frameUrlForIndex(page, frameIdx) : undefined,
        urlAfter: page.url(),
      });
      return `Typed into ${role} "${name}".`;
    }
    case "selectOption": {
      const { ref, value } = toolUse.input as { ref: string; value: string };
      const cssPath = await captureCssPath(page, ref);
      await doSelectOption(page, ref, value, 5000);
      const { frameIdx, role, name } = parseRef(ref);
      const paramName = matchParam(opts.params, value);
      steps.push({
        action: "selectOption",
        description: `Select "${value}" in ${role} "${name}"`,
        role,
        name,
        cssPath,
        literalValue: paramName ? undefined : value,
        paramName,
        frameUrl: frameIdx > 0 ? await frameUrlForIndex(page, frameIdx) : undefined,
        urlAfter: page.url(),
      });
      return `Selected "${value}" in ${role} "${name}".`;
    }
    case "navigate": {
      const { url } = toolUse.input as { url: string };
      assertOriginAllowed(opts.allowlist, url);
      await doNavigate(page, url, 10_000);
      steps.push({ action: "navigate", description: `Navigate to ${url}`, literalValue: url, urlAfter: page.url() });
      return `Navigated to ${url}.`;
    }
    case "waitFor": {
      const { ms } = toolUse.input as { ms: number };
      const clamped = Math.min(Math.max(ms, 0), 10_000);
      await page.waitForTimeout(clamped);
      steps.push({ action: "waitFor", description: `Wait ${clamped}ms`, literalValue: String(clamped), urlAfter: page.url() });
      return `Waited ${clamped}ms.`;
    }
    case "extract": {
      const { key, value } = toolUse.input as { key: string; value: string };
      const found = await findLabelForValue(page, value);
      steps.push({
        action: "extract",
        description: `Extract "${key}"`,
        extractKey: key,
        extractLabel: found?.label,
        frameUrl: found && found.frameIdx > 0 ? await frameUrlForIndex(page, found.frameIdx) : undefined,
        literalValue: value,
        urlAfter: page.url(),
      });
      return `Recorded output "${key}".`;
    }
    default:
      throw new Error(`Unknown tool: ${toolUse.name}`);
  }
}

function matchParam(params: Record<string, string>, value: string): string | undefined {
  for (const [name, paramValue] of Object.entries(params)) {
    if (paramValue === value) return name;
  }
  return undefined;
}

async function screenshotBlock(page: Page): Promise<Anthropic.ImageBlockParam> {
  const buffer = await page.screenshot({ type: "png" });
  return { type: "image", source: { type: "base64", media_type: "image/png", data: buffer.toString("base64") } };
}

function relativeToEvidence(path: string): string {
  return path.replace(/^evidence[\\/]/, "");
}
