/**
 * 秘密情報の保存時暗号化 (at-rest) ヘルパ.
 *
 * Slack の bot/app token を DB に平文で持たないための最小の対称暗号 (AES-256-GCM).
 * マスター鍵は DB の外 (env or 鍵ファイル) に置くので、 DB を dump しても token は
 * 復号できない (AIFormat §7 / coding-conventions §14: secret は平文保存しない).
 *
 * 形式: `enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>` (GCM 認証付き).
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync, openSync, writeSync, closeSync } from "node:fs";

const PREFIX = "enc:v1:";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`SecretBox key must be ${KEY_BYTES} bytes (got ${key.length})`);
    }
  }

  /** 平文 → `enc:v1:...`. */
  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + [iv, tag, ct].map((b) => b.toString("base64")).join(":");
  }

  /** `enc:v1:...` → 平文. 形式不正 / 改竄 / 鍵違いは throw. */
  decrypt(enc: string): string {
    if (!isEncrypted(enc)) throw new Error("secret-box: not an encrypted value");
    const parts = enc.slice(PREFIX.length).split(":");
    if (parts.length !== 3) throw new Error("secret-box: malformed ciphertext");
    const [iv, tag, ct] = parts.map((p) => Buffer.from(p, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
}

/** 値が secret-box で暗号化済みか. */
export function isEncrypted(s: string | null | undefined): boolean {
  return typeof s === "string" && s.startsWith(PREFIX);
}

/** 鍵ファイルを読んで 32byte に検証する. 不正長は throw (黙って再生成すると既存暗号文を失う). */
function readKeyFile(keyFile: string): Buffer {
  const buf = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
  if (buf.length !== KEY_BYTES) {
    throw new Error(`secret-box: key file ${keyFile} is invalid (expected ${KEY_BYTES}-byte base64)`);
  }
  return buf;
}

/**
 * マスター鍵を解決する.
 *  1. env 値があれば、 その passphrase を sha256 で 32byte 化 (任意文字列を受け付ける)
 *  2. 鍵ファイルがあれば base64(32byte) を読む (壊れていれば throw — 黙って再生成すると既存暗号文を失う)
 *  3. どちらも無ければ 32byte をランダム生成し鍵ファイルへ保存 (初回利用時)
 *
 * 3 の生成→保存は `wx` (O_CREAT|O_EXCL) で原子的に行う. 複数 process が同時に初回起動して
 * existsSync が両方 false を返しても、 ファイル作成に勝てるのは 1 つだけで、 敗者は EEXIST を受けて
 * 勝者の鍵を読み直す. これをしないと別々の鍵で書き込み合い、 先に暗号化した token が復号不能になる.
 */
export function resolveSecretKey(opts: { envValue?: string | null; keyFile: string }): Buffer {
  const env = opts.envValue?.trim();
  if (env) return createHash("sha256").update(env, "utf8").digest();

  if (existsSync(opts.keyFile)) {
    return readKeyFile(opts.keyFile);
  }

  const key = randomBytes(KEY_BYTES);
  let fd: number;
  try {
    fd = openSync(opts.keyFile, "wx"); // O_CREAT|O_EXCL|O_WRONLY — 既存なら EEXIST で失敗
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      // 別 process が一足先に生成した — そちらの鍵を読み直す (race の敗者経路)
      return readKeyFile(opts.keyFile);
    }
    throw e;
  }
  try {
    writeSync(fd, key.toString("base64"));
  } finally {
    closeSync(fd);
  }
  return key;
}

export function loadSecretBox(opts: { envValue?: string | null; keyFile: string }): SecretBox {
  return new SecretBox(resolveSecretKey(opts));
}
