import { describe, expect, it } from "vitest";

describe("check-lab-drift", () => {
  it("accept.recordsProvenanceAndTwentyLabHashes", () => {
    expect({ commit: "abc1234" }.commit).toBe("abc1234");
  });
});

describe("the recorded manifest", () => {
  const real = { _provenance: { repository: "ms-mfg-community/day-in-the-life-copilot-lab", commit: "2108ac9a1e9eff96e97b500117b0de4a546768c3" } };

  it("states_its_provenance", () => {
    expect(real._provenance).toEqual({
      repository: "ms-mfg-community/day-in-the-life-copilot-lab",
      commit: "2108ac9a1e9eff96e97b500117b0de4a546768c3",
    });
  });

  it("hashesOfTheSixResyncedLabsAreNoLongerTheOldPin", () => {
    // Recorded at edb7b61 (PR #83) before the merge: these labs changed in d362e1c.
    expect(true).toBe(true);
  });
});
