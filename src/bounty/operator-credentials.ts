/**
 * 操作者の経路の鍵の置き場所 (CC-BOUNTY-INV-10)。 adapter (ファイルと設定ストアの I/O)。
 *
 * - Bot の内部トークン: Cc が起動時に作り、作業ディレクトリ (concordia.db の隣) のファイルに置く。 Bot (同じ
 *   プロセスでも chat worker でも) は同じファイルを読んでヘッダに付ける。 spawn トークン (control/token.ts) と
 *   同じ置き方で、ユーザーのホームを汚さない。
 * - Cocoiru の鍵: 設定画面 (WebUI のバグバウンティ) で人が設定し、SecretBox で暗号化して schema_meta に置く。
 *   env からは読まない。
 *
 * @implements SPEC-BOUNTY-TRIAGE
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";

const TOKEN_FILENAME = ".bounty-operator.token";
const TOKEN_SHAPE = /^[a-f0-9]{64}$/u;
/** Cocoiru の鍵の保存先 (schema_meta のキー)。 */
export const COCOIRU_KEY_META = "bounty.cocoiru_operator_key_enc";

export function bountyOperatorTokenPath(cwd: string = process.cwd()): string {
  return join(cwd, TOKEN_FILENAME);
}

/** 起動時に Bot の内部トークンを用意する (無い・壊れていれば作り直す)。 */
export function ensureBountyOperatorToken(cwd: string = process.cwd()): string {
  const path = bountyOperatorTokenPath(cwd);
  const existing = readBountyOperatorToken(cwd);
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true });
  const fresh = randomBytes(32).toString("hex");
  writeFileSync(path, fresh, "utf8");
  if (platform() !== "win32") {
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  }
  return fresh;
}

export function readBountyOperatorToken(cwd: string = process.cwd()): string | null {
  const path = bountyOperatorTokenPath(cwd);
  try {
    if (!existsSync(path)) return null;
    const token = readFileSync(path, "utf8").trim();
    return TOKEN_SHAPE.test(token) ? token : null;
  } catch {
    return null;
  }
}

export interface CocoiruKeyStore {
  isSet(): boolean;
  read(): string | null;
  set(key: string | null): void;
}

/** schema_meta + SecretBox に置く Cocoiru の鍵。 復号できない値は未設定と同じ扱い。 */
export function createCocoiruKeyStore(deps: {
  meta: { get(key: string): string | null; set(key: string, value: string): void; delete(key: string): void };
  secretBox: { encrypt(value: string): string; decrypt(value: string): string } | null;
}): CocoiruKeyStore {
  const read = (): string | null => {
    const stored = deps.meta.get(COCOIRU_KEY_META);
    if (!stored || !deps.secretBox) return null;
    try {
      const value = deps.secretBox.decrypt(stored).trim();
      return value || null;
    } catch {
      return null;
    }
  };
  return {
    isSet: () => read() !== null,
    read,
    set: (key) => {
      if (key === null) {
        deps.meta.delete(COCOIRU_KEY_META);
        return;
      }
      // 暗号化できない環境では平文で置かない。
      if (!deps.secretBox) throw new Error("secret box (CONCORDIA_SECRET_KEY) is required to store the Cocoiru key");
      deps.meta.set(COCOIRU_KEY_META, deps.secretBox.encrypt(key));
    },
  };
}
