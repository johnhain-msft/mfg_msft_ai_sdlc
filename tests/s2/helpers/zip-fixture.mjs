// ZIP archives for the tests, written the way actions/upload-artifact writes them: deflated entries whose local headers carry no
// sizes (general-purpose flag bit 3, the sizes and the CRC in a data descriptor after the data) and a central directory that holds
// the real values. The CRC comes from node:zlib where it exists, so that a fixture never depends on the reader's own CRC function.

import zlib from "node:zlib";
import { crc32 } from "../../../src/drift/lib/zip.mjs";

export function zipOf(files, { method = 8, descriptor = true, comment = "" } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const packed = method === 8 ? zlib.deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name, "utf8");
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32(data);
    const flags = (descriptor ? 0x0008 : 0) | 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(descriptor ? 0 : crc, 14);
    local.writeUInt32LE(descriptor ? 0 : packed.length, 18);
    local.writeUInt32LE(descriptor ? 0 : data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const trailer = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      trailer.writeUInt32LE(0x08074b50, 0);
      trailer.writeUInt32LE(crc, 4);
      trailer.writeUInt32LE(packed.length, 8);
      trailer.writeUInt32LE(data.length, 12);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed, trailer);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length + trailer.length;
  }
  const directory = Buffer.concat(centrals);
  const commentBytes = Buffer.from(comment, "utf8");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...locals, directory, end, commentBytes]);
}
