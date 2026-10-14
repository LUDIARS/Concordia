/**
 * 相談のファイル受け渡しのデータフォルダ操作 (node:fs) (spec/feature/tech-consultation.md §6.4)。
 * 取り込みは既存のファイルを上書きしない (`wx`)。
 *
 * @implements SPEC-CONSULT-DRIVE-TRANSFER
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TransferFiles } from "./drive-transfer-service.js";

export function nodeTransferFiles(): TransferFiles {
  return {
    async list(dir) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const files: Array<{ name: string; size: number }> = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        files.push({ name: entry.name, size: (await stat(join(dir, entry.name))).size });
      }
      return files;
    },
    async read(path) {
      return new Uint8Array(await readFile(path));
    },
    async writeNew(path, bytes) {
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(path, bytes, { flag: "wx" });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    },
  };
}
