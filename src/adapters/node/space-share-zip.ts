import { crc32 } from "node:zlib";
import { MAX_WORKBENCH_SHARE_BYTES } from "../../shared/workbench-product";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    ((date.getHours() & 31) << 11) |
    ((date.getMinutes() & 63) << 5) |
    (Math.floor(date.getSeconds() / 2) & 31);
  const dos =
    (((date.getFullYear() - 1980) & 127) << 9) |
    (((date.getMonth() + 1) & 15) << 5) |
    (date.getDate() & 31);
  return { time, date: dos };
}

export function packZip(entries: ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, eocd]);
}

export function unpackZip(archive: Buffer, maxBytes = MAX_WORKBENCH_SHARE_BYTES): ZipEntry[] {
  if (archive.length > maxBytes) throw new Error("The space share archive is too large.");
  if (archive.length < 22) throw new Error("The space share archive is not a zip.");
  let eocd = -1;
  for (let i = archive.length - 22; i >= 0 && i >= archive.length - 22 - 65535; i -= 1) {
    if (archive.readUInt32LE(i) === 0x06054b50 && i + 22 + archive.readUInt16LE(i + 20) === archive.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("The space share archive is not a zip.");
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const centralStart = offset, centralSize = archive.readUInt32LE(eocd + 12);
  if (archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 6) !== 0 ||
      archive.readUInt16LE(eocd + 8) !== count || centralStart + centralSize !== eocd ||
      count > Math.floor(centralSize / 46)) throw new Error("The space share archive is not a zip.");
  // Validate all ranges and the complete payload budget before making any payload copies.
  const records: {name: string; start: number; end: number; local: number}[] = [];
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > eocd || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("The space share archive is not a zip.");
    }
    const method = archive.readUInt16LE(offset + 10);
    const compressed = archive.readUInt32LE(offset + 20);
    const nameLen = archive.readUInt16LE(offset + 28);
    const extraLen = archive.readUInt16LE(offset + 30);
    const commentLen = archive.readUInt16LE(offset + 32);
    const localOff = archive.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLen + extraLen + commentLen;
    if (nextOffset > eocd || archive.readUInt16LE(offset + 34) !== 0) throw new Error("The space share archive is not a zip.");
    const name = archive.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    if (method !== 0) throw new Error(`Compressed zip entries are not supported: ${name}`);
    const flags = archive.readUInt16LE(offset + 8);
    if ((flags & 1) !== 0 || compressed !== archive.readUInt32LE(offset + 24) ||
        localOff + 30 > centralStart || archive.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error("The space share archive is not a zip.");
    }
    const localNameLen = archive.readUInt16LE(localOff + 26);
    const localExtra = archive.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtra;
    const dataEnd = dataStart + compressed;
    if (dataEnd > centralStart || archive.readUInt16LE(localOff + 8) !== method ||
        archive.readUInt16LE(localOff + 6) !== flags || localNameLen !== nameLen ||
        !archive.subarray(localOff + 30, localOff + 30 + localNameLen).equals(archive.subarray(offset + 46, offset + 46 + nameLen)) ||
        (!(flags & 8) && (archive.readUInt32LE(localOff + 18) !== compressed || archive.readUInt32LE(localOff + 22) !== compressed))) {
      throw new Error("The space share archive is not a zip.");
    }
    total += compressed;
    if (total > maxBytes) throw new Error("The space share archive is too large.");
    records.push({name, start:dataStart, end:dataEnd, local:localOff});
    offset = nextOffset;
  }
  if (offset !== eocd) throw new Error("The space share archive is not a zip.");
  const ranges = [...records].sort((a, b) => a.local - b.local);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]!.local < ranges[i - 1]!.end) throw new Error("The space share archive contains overlapping entries.");
  }
  return records.filter(record => !record.name.endsWith("/"))
    .map(record => ({name:record.name, data:Buffer.from(archive.subarray(record.start, record.end))}));
}
