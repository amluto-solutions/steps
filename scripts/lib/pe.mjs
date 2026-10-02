// Reads the functions a Windows .exe imports, straight from its PE headers, so the release can
// prove the shipped app doesn't import SendInput (docs/engineering.md#gates). No tools needed.
import { readFileSync } from "node:fs";

/**
 * @param {string} path
 * @returns {Map<string, string[]>} DLL name (lower case) → imported function names (or #ordinal)
 */
export function peImports(path) {
  const data = readFileSync(path);
  if (data.readUInt16LE(0) !== 0x5a4d) throw new Error(`${path}: not an MZ executable`);
  const pe = data.readUInt32LE(0x3c);
  if (data.readUInt32LE(pe) !== 0x4550) throw new Error(`${path}: no PE header`);
  const sectionCount = data.readUInt16LE(pe + 6);
  const optionalSize = data.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const magic = data.readUInt16LE(optional);
  const is64 = magic === 0x20b;
  if (!is64 && magic !== 0x10b) throw new Error(`${path}: unknown optional header`);
  const directories = optional + (is64 ? 112 : 96);
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const at = optional + optionalSize + index * 40;
    sections.push({
      address: data.readUInt32LE(at + 12),
      size: Math.max(data.readUInt32LE(at + 8), data.readUInt32LE(at + 16)),
      raw: data.readUInt32LE(at + 20),
    });
  }
  const offset = (rva) => {
    const section = sections.find((item) => rva >= item.address && rva < item.address + item.size);
    if (!section)
      throw new Error(`${path}: address 0x${rva.toString(16)} is outside every section`);
    return rva - section.address + section.raw;
  };
  const text = (rva) => {
    const start = offset(rva);
    return data.toString("latin1", start, data.indexOf(0, start));
  };

  const imports = new Map();
  const readTable = (descriptorRva, descriptorSize, nameAt, thunkAt, skip) => {
    if (descriptorRva === 0) return;
    for (let at = offset(descriptorRva); ; at += descriptorSize) {
      const nameRva = data.readUInt32LE(at + nameAt);
      if (nameRva === 0) break;
      const dll = text(nameRva).toLowerCase();
      const names = imports.get(dll) ?? [];
      const thunkRva = data.readUInt32LE(at + thunkAt) || data.readUInt32LE(at + skip);
      for (let thunk = offset(thunkRva); ; thunk += is64 ? 8 : 4) {
        const value = is64 ? data.readBigUInt64LE(thunk) : BigInt(data.readUInt32LE(thunk));
        if (value === 0n) break;
        const byOrdinal = is64 ? value >> 63n === 1n : value >> 31n === 1n;
        names.push(
          byOrdinal ? `#${Number(value & 0xffffn)}` : text(Number(value & 0x7fffffffn) + 2),
        );
      }
      imports.set(dll, names);
    }
  };
  // Import directory: name at +12, lookup table at +0 (or the address table at +16).
  readTable(data.readUInt32LE(directories + 8), 20, 12, 0, 16);
  // Delay-load directory: name at +4, name table at +16 (address table at +12).
  readTable(data.readUInt32LE(directories + 13 * 8), 32, 4, 16, 12);
  return imports;
}
