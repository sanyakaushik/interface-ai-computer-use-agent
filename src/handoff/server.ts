// Minimal, real control-transfer server (spec 3.6). What's mocked and declared as such: the
// "operator UI" here is a bare status/resume page, not a real co-browsing console. What's real:
// the pause/resume signaling, the context carried across the handoff, and the fact that the
// actual live session the human takes over is the same headed Chromium window the automation
// was driving (not a fresh session) — this server only coordinates *when* the automation is
// allowed to keep issuing commands, it never proxies the browser itself.
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createIntervention, getIntervention, listInterventions, resumeIntervention } from "./store.js";
import type { CreateInterventionInput } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HANDOFF_PORT ?? 4100);

export function startHandoffServer(port = PORT) {
  const app = express();
  app.use(express.json());
  app.use("/evidence", express.static("evidence"));

  app.get("/operator", (_req, res) => {
    res.sendFile(join(__dirname, "operator.html"));
  });

  app.get("/operator.html", (_req, res) => {
    res.sendFile(join(__dirname, "operator.html"));
  });

  app.post("/interventions", (req, res) => {
    const body = req.body as CreateInterventionInput;
    const record = createIntervention(body);
    console.log(`[handoff] intervention created: ${record.id} (${record.reason})`);
    res.status(201).json(record);
  });

  app.get("/interventions", (_req, res) => {
    res.json(listInterventions());
  });

  app.get("/interventions/:id", (req, res) => {
    const record = getIntervention(req.params.id);
    if (!record) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(record);
  });

  app.post("/interventions/:id/resume", (req, res) => {
    const record = resumeIntervention(req.params.id, req.body?.notes);
    if (!record) {
      res.status(404).json({ error: "not found" });
      return;
    }
    console.log(`[handoff] intervention resumed: ${record.id}`);
    res.json(record);
  });

  return app.listen(port, () => {
    console.log(`[handoff] control server listening on http://localhost:${port} (operator page: /operator)`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startHandoffServer();
}
