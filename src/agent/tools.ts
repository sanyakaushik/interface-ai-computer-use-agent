// Tool contract offered to the LLM during discovery. Kept intentionally small and literal
// (click/type/selectOption/navigate/waitFor/extract/finish_success/report_stuck) — no
// open-ended "run_javascript" or "execute_code" tool, so the allowlist's action-type check has
// something meaningful to enforce (spec 3.4).
import type Anthropic from "@anthropic-ai/sdk";

export const DISCOVERY_TOOLS: Anthropic.Tool[] = [
  {
    name: "click",
    description: "Click an interactive element identified by its ref from the last observation.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string", description: "The element ref, e.g. 'button::Search::0'." } },
      required: ["ref"],
    },
  },
  {
    name: "type",
    description: "Type text into a textbox identified by its ref, replacing any existing value.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: { type: "string" },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "selectOption",
    description: "Choose an option (by its value attribute) in a combobox identified by its ref.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        value: { type: "string" },
      },
      required: ["ref", "value"],
    },
  },
  {
    name: "navigate",
    description: "Navigate the browser to an absolute URL. Must stay within the allowed origin.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "waitFor",
    description: "Wait a short time for the page to settle (e.g. after a slow-loading action).",
    input_schema: {
      type: "object",
      properties: { ms: { type: "number" } },
      required: ["ms"],
    },
  },
  {
    name: "extract",
    description: "Record a piece of data read from the current page as a named output value.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Output field name, e.g. 'savingsBalance'." },
        value: { type: "string" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "finish_success",
    description: "Declare the goal has been fully accomplished. Include all extracted outputs.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        outputs: { type: "object", description: "Map of output field name -> value, from prior extract calls." },
      },
      required: ["summary"],
    },
  },
  {
    name: "report_stuck",
    description:
      "Declare that you cannot safely or reliably continue (ambiguous state, unexpected error, action outside allowed scope, or a risky/irreversible step you should not take unattended) and need a human to take over.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];
