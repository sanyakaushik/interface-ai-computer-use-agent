import "dotenv/config";
import { runDiscovery } from "./agent/loop.js";
import { buildArtifact } from "./artifact/recorder.js";
import { saveArtifact, loadArtifact } from "./artifact/store.js";
import { loadAllowlist } from "./safety/allowlist.js";
import { loadOutcomeRules } from "./replay/outcomes.js";
import { runReplay } from "./replay/engine.js";
import { startHandoffServer } from "./handoff/server.js";
import { startCapabilityApi } from "./capabilities/api.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function parseParams(spec: string | undefined): Record<string, string> {
  if (!spec) return {};
  const out: Record<string, string> = {};
  for (const pair of spec.split(",")) {
    const [key, ...rest] = pair.split("=");
    if (key) out[key.trim()] = rest.join("=").trim();
  }
  return out;
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (command === "discover") {
    const goal = required(args, "goal");
    const target = args.target ?? "http://localhost:4000";
    const params = parseParams(args.params);
    const id = required(args, "id");
    const name = args.name ?? id;
    const description = args.description ?? goal;
    const appId = args.appId ?? "riverside-servicing-console";
    const vendorProduct = args.vendorProduct ?? "AcmeCore Servicing UI";
    const vendorVersion = args.vendorVersion ?? "1.0";
    const maxSteps = args.maxSteps ? Number(args.maxSteps) : undefined;
    const headless = args.headless === "true";

    const allowlist = loadAllowlist();
    console.log(`[discover] goal: ${goal}`);
    console.log(`[discover] target: ${target}`);
    console.log(`[discover] params: ${JSON.stringify(params)}`);

    const result = await runDiscovery({ goal, targetUrl: target, allowlist, params, maxSteps, headless });
    console.log(`[discover] result:`, result.status);

    if (result.status !== "success") {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 1;
      return;
    }

    const artifact = buildArtifact(allowlist, {
      id,
      name,
      description,
      discoveryRunId: result.runId,
      target: { appId, vendorProduct, vendorVersion, baseUrlPattern: target },
      params,
      steps: result.steps,
      finalSummary: result.summary,
    });

    const outPath = `artifacts/${id}.json`;
    saveArtifact(outPath, artifact);
    console.log(`[discover] saved artifact -> ${outPath}`);
    console.log(`[discover] evidence -> evidence/${result.runId}/`);
    console.log(`[discover] outputs:`, result.outputs);
    return;
  }

  if (command === "replay") {
    const artifactPath = required(args, "artifact");
    const params = parseParams(args.params);
    const confirmIrreversible = args["confirm-irreversible"] === "true";
    const escalateOnFailure = args["escalate-on-failure"] === "true";
    const headed = args.headed === "true";
    const tenantId = args.tenant;

    const artifact = loadArtifact(artifactPath);
    const allowlist = loadAllowlist();
    const outcomeRules = loadOutcomeRules(`outcome-rules.${artifact.target.appId}.json`);

    console.log(`[replay] capability: ${artifact.id} v${artifact.capabilityVersion}`);
    console.log(`[replay] params: ${JSON.stringify(params)}`);
    if (tenantId) console.log(`[replay] tenant: ${tenantId}`);

    const result = await runReplay({
      artifact,
      params,
      allowlist,
      outcomeRules,
      confirmIrreversible,
      escalateOnFailure,
      headless: !headed,
      tenantId,
    });

    console.log(`[replay] result:`, JSON.stringify(result, null, 2));
    if (result.status === "failure") process.exitCode = 1;
    return;
  }

  if (command === "serve") {
    startCapabilityApi();
    return;
  }

  if (command === "handoff") {
    startHandoffServer();
    return;
  }

  console.error(`Unknown command "${command}". Expected one of: discover, replay, serve, handoff.`);
  process.exitCode = 1;
}

function required(args: Record<string, string>, key: string): string {
  const value = args[key];
  if (!value) {
    console.error(`Missing required --${key} argument.`);
    process.exit(1);
  }
  return value;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
