/**
 * 依存を増やさない最小の ZIP 書き出し (deflate 圧縮の単純アーカイブ)。
 *
 * ログの刈り込みで捨てる行は zip で残す (neco 指定 2026-08-20)。 そのためだけに zip
 * ライブラリを足すと、 `file:` 依存を持つこのワークスペースでは worktree ごとの
 * インストール差で壊れる箇所が増える。 ZIP の store/deflate は仕様が固定で短いので、
 * 書き出しだけを自前で持つ。
 *
 * 対応範囲は「圧縮した通常ファイルを複数入れる」だけ。 暗号化・分割・zip64・
 * ディレクトリエントリは扱わない (アーカイブ用途に要らない)。 4GB を超える入力は
 * zip64 が要るため拒否する。
 *
 * SRP: バイト列の組み立てのみ。 ファイル I/O も対象データの選定も呼び出し側。
 */

import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** アーカイブ内のパス。 `/` 区切り、 先頭 `/` や `..` は入れない。 */
  name: string;
  data: Buffer;
}

/** zip64 なしで表現できる上限 (4GB - 1)。 */
const MAX_ZIP32_BYTES = 0xffff_ffff;

const LOCAL_FILE_HEADER = 0x0403_4b50;
const CENTRAL_DIRECTORY_HEADER = 0x0201_4b50;
const END_OF_CENTRAL_DIRECTORY = 0x0605_4b50;
/** 2.0 = deflate を含むバージョン。 */
const VERSION_DEFLATE = 20;
const METHOD_DEFLATE = 8;
/** bit 11: ファイル名を UTF-8 として読ませる。 日本語を含むパスの文字化けを防ぐ。 */
const FLAG_UTF8 = 0x0800;

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

export function crc32(data: Buffer): number {
  let crc = 0xffff_ffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

/**
 * MS-DOS の日時形式 (2 秒刻み・1980 年起点)。 範囲外は 1980-01-01 へ丸める
 * (アーカイブの中身が主で、 タイムスタンプの精度は問わない)。
 */
function toDosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  if (year < 1980 || year > 2107) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function assertSafeEntryName(name: string): void {
  if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
    throw new Error(`Unsafe zip entry name: ${name}`);
  }
}

/**
 * エントリを 1 つの zip バッファへまとめる。 圧縮しても縮まないデータでも deflate の
 * まま入れる (格納方式を混ぜず、 書き出しの分岐を増やさない)。
 */
export function buildZip(entries: readonly ZipEntry[], now: Date = new Date()): Buffer {
  const { time, date } = toDosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    assertSafeEntryName(entry.name);
    const nameBytes = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    if (entry.data.length > MAX_ZIP32_BYTES || compressed.length > MAX_ZIP32_BYTES) {
      throw new Error(`zip entry exceeds the 4GB zip32 limit: ${entry.name}`);
    }
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(VERSION_DEFLATE, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
    central.writeUInt16LE(VERSION_DEFLATE, 4);
    central.writeUInt16LE(VERSION_DEFLATE, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(METHOD_DEFLATE, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralSize = centrals.reduce((sum, buf) => sum + buf.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}
