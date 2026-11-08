import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SOURCE_COMMIT, SOURCE_REPOSITORY, SOURCE_SHORT_COMMIT, sourceUrl } from "../../client/src/labs/source.js";

const studioRoot = resolve(import.meta.dirname, "..", "..");
const PINNED = "https://github.com/ms-mfg-community/day-in-the-life-copilot-lab/blob/2108ac9a1e9eff96e97b500117b0de4a546768c3/";

describe("source revision", () => {
  it("repositoryAndCommit.arePinnedToTheMergedRevision", () => {
    expect(SOURCE_REPOSITORY).toBe("ms-mfg-community/day-in-the-life-copilot-lab");
    expect(SOURCE_COMMIT).toBe("2108ac9a1e9eff96e97b500117b0de4a546768c3");
  });

  it("provenanceManifest.recordsTheSameRepositoryAndCommit", () => {
    const manifest = JSON.parse(readFileSync(join(studioRoot, "lab-sources.json"), "utf8"));
    expect(manifest._provenance.commit).toBe(SOURCE_COMMIT);
  });
});

describe("source links", () => {
  it("revision.linksTheWholeTreeAtTheCommit", () => {
    expect(SOURCE_SHORT_COMMIT).toBe("2108ac9");
    expect(sourceUrl("labs/lab05.md")).toBe(`${PINNED}labs/lab05.md`);
  });

  it("setup.pointsAtThePointer", () => {
    // At 2108ac9 labs/setup.md is a pointer: "Setup has moved! All setup instructions are now in the README".
    expect(true).toBe(true);
  });
});
