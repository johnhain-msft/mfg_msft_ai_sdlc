// The ZIP reader that opens the watch-index artifact of the previous run (SPEC-02 AC41).
import assert from "node:assert/strict";
import test from "node:test";
import { crc32, readZipEntry, ZipError } from "../../src/drift/lib/zip.mjs";
import { zipOf } from "./helpers/zip-fixture.mjs";

test("crc32 is the standard CRC-32 (the check value of '123456789')", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("an entry is read from an artifact-style archive: deflated, sizes only in the central directory, after another entry and before a comment", () => {
  const archive = zipOf({ "other.txt": "x".repeat(1000), "watch-index.json": '{"version":1}' }, { comment: "made by a test" });
  assert.equal(readZipEntry(archive, "watch-index.json").toString("utf8"), '{"version":1}');
  assert.equal(readZipEntry(archive, "other.txt").toString("utf8"), "x".repeat(1000));
  assert.equal(readZipEntry(archive, "missing.json"), null);
});

test("a stored entry with the sizes in its local header is read as well", () => {
  assert.equal(readZipEntry(zipOf({ "a.json": "[1,2]" }, { method: 0, descriptor: false }), "a.json").toString("utf8"), "[1,2]");
});

test("a damaged archive is refused, never read as something else", () => {
  const archive = zipOf({ "watch-index.json": '{"version":1,"sources":[]}' });
  assert.throws(() => readZipEntry(Buffer.from("not a zip at all"), "watch-index.json"), ZipError);
  const corrupt = Buffer.from(archive);
  corrupt[30 + "watch-index.json".length + 2] ^= 0xff; // inside the deflated data, after the 30-byte local header and the name
  assert.throws(() => readZipEntry(corrupt, "watch-index.json"), ZipError);
  assert.throws(() => readZipEntry(archive.subarray(0, archive.length - 10), "watch-index.json"), ZipError, "a truncated archive has no end record");
});

test("an entry larger than the limit is refused before it is inflated", () => {
  const archive = zipOf({ "big.json": "0".repeat(5000) });
  assert.throws(() => readZipEntry(archive, "big.json", { maxSize: 1000 }), /larger than 1000 bytes/);
});
