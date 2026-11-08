// 2108ac9a1e9eff96e97b500117b0de4a546768c3 in a line comment, and its short form 2108ac9
/* 2108ac9a1e9eff96e97b500117b0de4a546768c3
   2108ac9 in a block comment */
export const PINNED = "2108ac9a1e9eff96e97b500117b0de4a546768c3"; // trailing comment with 2108ac9
export const URL_FORM = "https://github.com/acme/tree/2108ac9a1e9eff96e97b500117b0de4a546768c3/docs"; // https://example.test/2108ac9a1e9eff96e97b500117b0de4a546768c3
export const SHORT = "2108ac9";
const regex = /^https?:\/\/[a-z]+\//; const division = 10 / 2 / 5;
const template = `blob/2108ac9a1e9eff96e97b500117b0de4a546768c3/x ${division} // not a comment`;
export function check(value: string): void {
  expect(value).toBe("2108ac9");
  expect(value).not.toBe(`${division}`);
  call("2108ac9");
}
