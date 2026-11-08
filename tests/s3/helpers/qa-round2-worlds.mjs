// QA fixtures whose pre-first-merge cursor is the real bootstrap baseline.
import fs from "node:fs";
import YAML from "yaml";
import { createShowcaseWorld } from "./preflight-world.mjs";

export function seededShowcaseWorld(options = {}) {
  const world = createShowcaseWorld(options);
  const edge = { ...world.edge, initialBaselineSha: world.upstreamShas[0] };
  world.edge = edge;
  world.w.edge = edge;
  world.w.env.EDGE_JSON = JSON.stringify(edge);
  fs.writeFileSync(
    world.w.workspace.path("sdlc.yaml"),
    YAML.stringify({ projects: [], dependencyEdges: [{ ...edge, syncScopes: ["showcase-runs"] }] }),
  );
  return world;
}
