import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { buildZip, crc32 } from "./zip-writer.js";

/** 中央ディレクトリを読んで、 実装の書式が仕様どおりかを外から確かめる。 */
function readSingleEntry(zip: Buffer): { name: string; data: Buffer } {
  expect(zip.readUInt32LE(0)).toBe(0x0403_4b50);
  const eocdSignature = 0x0605_4b50;
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== eocdSignature) eocd -= 1;
  expect(eocd).toBeGreaterThanOrEqual(0);
  expect(zip.readUInt16LE(eocd + 10)).toBe(1);

  const centralOffset = zip.readUInt32LE(eocd + 16);
  const compressedSize = zip.readUInt32LE(centralOffset + 20);
  const nameLength = zip.readUInt16LE(centralOffset + 28);
  const localOffset = zip.readUInt32LE(centralOffset + 42);
  const name = zip.toString("utf8", centralOffset + 46, centralOffset + 46 + nameLength);

  const localNameLength = zip.readUInt16LE(localOffset + 26);
  const extraLength = zip.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLength + extraLength;
  return { name, data: inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize)) };
}

describe("buildZip", () => {
  it("produces an archive a normal reader can open", () => {
    const payload = Buffer.from(`${JSON.stringify({ ts: 1, text: "ログ行" })}\n`, "utf8");
    const entry = readSingleEntry(buildZip([{ name: "transcript_logs.jsonl", data: payload }]));

    expect(entry.name).toBe("transcript_logs.jsonl");
    expect(entry.data.toString("utf8")).toBe(payload.toString("utf8"));
  });

  it("records the CRC of the uncompressed bytes", () => {
    // 既知値。 実装を書き換えても壊れないよう、 仕様上の定数で固定する。
    expect(crc32(Buffer.from("123456789", "utf8"))).toBe(0xcbf4_3926);
  });

  it("refuses entry names that would escape the archive root", () => {
    const data = Buffer.from("x", "utf8");
    expect(() => buildZip([{ name: "../escape.jsonl", data }])).toThrow(/Unsafe zip entry name/);
    expect(() => buildZip([{ name: "/abs.jsonl", data }])).toThrow(/Unsafe zip entry name/);
  });
});
