// A ZIP reader for one small entry of a GitHub Actions artifact (SPEC-02 AC41).
//
// The REST API hands an artifact out as a ZIP archive. actions/upload-artifact writes its entries deflated, with the sizes and the CRC in a
// data descriptor after the data (general-purpose flag bit 3) and the real values in the central directory, so the entry is located through
// the central directory and never through the local header's sizes. Stored (0) and deflated (8) entries are read; ZIP64, encryption and any
// other method are refused, as is an entry that is larger than the limit, an archive whose records do not hold together, and data whose
// CRC-32 or length differs from what the directory records: a damaged archive is never read as something else.

import zlib from "node:zlib";

export class ZipError extends Error {}

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const DEFAULT_MAX_SIZE = 20 * 1024 * 1024;

let table = null;
/** The standard CRC-32 (IEEE 802.3) of the bytes. */
export function crc32(bytes) {
  if (table === null) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function endOfDirectory(buffer) {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let position = buffer.length - 22; position >= lowest; position -= 1) {
    if (buffer.readUInt32LE(position) === END_OF_DIRECTORY && position + 22 + buffer.readUInt16LE(position + 20) === buffer.length) return position;
  }
  throw new ZipError("the archive has no end-of-central-directory record");
}

/**
 * The bytes of the entry `name`, or null when the archive has no such entry.
 * @param {Buffer} buffer the whole archive
 * @param {string} name the entry's path inside the archive
 * @param {{ maxSize?: number }} [options] the largest uncompressed size accepted
 */
export function readZipEntry(buffer, name, { maxSize = DEFAULT_MAX_SIZE } = {}) {
  const archive = Buffer.from(buffer);
  if (archive.length < 22) throw new ZipError("the archive is too short to be a ZIP file");
  const end = endOfDirectory(archive);
  const count = archive.readUInt16LE(end + 10);
  const size = archive.readUInt32LE(end + 12);
  const start = archive.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
  if (start + size > end) throw new ZipError("the central directory lies outside the archive");
  let position = start;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > end || archive.readUInt32LE(position) !== DIRECTORY_ENTRY) throw new ZipError("the central directory is damaged");
    const flags = archive.readUInt16LE(position + 8);
    const method = archive.readUInt16LE(position + 10);
    const crc = archive.readUInt32LE(position + 16);
    const packedSize = archive.readUInt32LE(position + 20);
    const plainSize = archive.readUInt32LE(position + 24);
    const nameLength = archive.readUInt16LE(position + 28);
    const extraLength = archive.readUInt16LE(position + 30);
    const commentLength = archive.readUInt16LE(position + 32);
    const localOffset = archive.readUInt32LE(position + 42);
    const entryName = archive.subarray(position + 46, position + 46 + nameLength).toString(flags & 0x0800 ? "utf8" : "latin1");
    position += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if (flags & 0x0001) throw new ZipError(`${name} is encrypted`);
    if (packedSize === 0xffffffff || plainSize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("ZIP64 entries are not supported");
    if (plainSize > maxSize) throw new ZipError(`${name} is larger than ${maxSize} bytes`);
    if (localOffset + 30 > start || archive.readUInt32LE(localOffset) !== LOCAL_HEADER) throw new ZipError(`the local header of ${name} is damaged`);
    const dataStart = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    if (dataStart + packedSize > start) throw new ZipError(`the data of ${name} runs past the central directory`);
    const packed = archive.subarray(dataStart, dataStart + packedSize);
    let data;
    if (method === 0) data = Buffer.from(packed);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, maxSize) });
      } catch (error) {
        throw new ZipError(`${name} cannot be inflated: ${error.message}`);
      }
    } else throw new ZipError(`${name} uses the unsupported compression method ${method}`);
    if (data.length !== plainSize || crc32(data) !== crc) throw new ZipError(`${name} does not match the size and CRC-32 that the archive records`);
    return data;
  }
  return null;
}
