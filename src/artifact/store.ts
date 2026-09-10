import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { CapabilityArtifact, parseArtifact } from "./schema.js";

export function loadArtifact(path: string): CapabilityArtifact {
  const raw = readFileSync(path, "utf-8");
  return parseArtifact(JSON.parse(raw));
}

export function saveArtifact(path: string, artifact: CapabilityArtifact): void {
  parseArtifact(artifact); // validate before writing
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(artifact, null, 2) + "\n", "utf-8");
}
