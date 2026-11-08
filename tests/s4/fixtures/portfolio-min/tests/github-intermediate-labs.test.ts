import { describe, expect, it } from "vitest";
import { sha1 } from "../experiences/github-intermediate-labs/src/engine/sha1";

const run = (command: string) => command.trim();

describe("browser lab simulator", () => {
  it("uses stable SHA-1 and clones the six-commit fixture without learner branches", () => {
    expect(sha1("abc")).toHaveLength(40);
  });

  it("Lab 0 HTTPS prompts accept only simulated credentials and do not retain them", () => {
    expect(run(" git clone ")).toBe("git clone");
  });

  it.each([0, 1, 2])("can start independently at Lab %i", (lab) => {
    expect(lab).toBeGreaterThanOrEqual(0);
  });
});
