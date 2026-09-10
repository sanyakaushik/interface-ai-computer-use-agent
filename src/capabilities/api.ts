// Stretch goal: agent-facing capability interface. Exposes saved artifacts as a small catalog an
// AI agent could discover and invoke by name with typed args, backed by the same deterministic
// replay engine used by the CLI — no separate execution path to keep in sync.
import express from "express";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadArtifact } from "../artifact/store.js";
import { loadAllowlist } from "../safety/allowlist.js";
import { loadOutcomeRules } from "../replay/outcomes.js";
import { runReplay } from "../replay/engine.js";
import { redactParams } from "../safety/redaction.js";

const PORT = Number(process.env.CAPABILITY_API_PORT ?? 4200);
const ARTIFACTS_DIR = "artifacts";

function listArtifactFiles(): string[] {
  return readdirSync(ARTIFACTS_DIR).filter((f) => f.endsWith(".json"));
}

export function startCapabilityApi(port = PORT) {
  const app = express();
  app.use(express.json());

  app.get("/capabilities", (_req, res) => {
    const catalog = listArtifactFiles().map((file) => {
      const artifact = loadArtifact(join(ARTIFACTS_DIR, file));
      return {
        id: artifact.id,
        name: artifact.name,
        description: artifact.description,
        status: artifact.status,
        capabilityVersion: artifact.capabilityVersion,
        inputParams: artifact.inputParams,
        outputs: artifact.outputs,
      };
    });
    res.json(catalog);
  });

  app.post("/capabilities/:id/invoke", async (req, res) => {
    const file = listArtifactFiles().find((f) => loadArtifact(join(ARTIFACTS_DIR, f)).id === req.params.id);
    if (!file) {
      res.status(404).json({ error: `Unknown capability "${req.params.id}".` });
      return;
    }
    const artifact = loadArtifact(join(ARTIFACTS_DIR, file));
    const allowlist = loadAllowlist();
    const outcomeRules = loadOutcomeRules(`outcome-rules.${artifact.target.appId}.json`);
    const params = (req.body?.params ?? {}) as Record<string, string>;
    const confirmIrreversible = Boolean(req.body?.confirmIrreversible);

    const sensitiveNames = new Set(artifact.inputParams.filter((p) => p.sensitive).map((p) => p.name));
    console.log(`[capabilities] invoking "${artifact.id}" with`, redactParams(params, sensitiveNames));

    try {
      const result = await runReplay({ artifact, params, allowlist, outcomeRules, confirmIrreversible, headless: true });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return app.listen(port, () => {
    console.log(`[capabilities] agent-facing capability API listening on http://localhost:${port}`);
    console.log(`[capabilities] try: curl http://localhost:${port}/capabilities`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startCapabilityApi();
}
