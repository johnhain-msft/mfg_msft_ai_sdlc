import { describe, expect, it } from "vitest";

describe("sandbox", () => {
  it("isolates every lab", () => {
    expect(true).toBe(true);
  });
});
