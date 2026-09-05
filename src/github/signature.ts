/**
 * GitHub webhook 署名の検証 (純関数)。
 *
 * `X-Hub-Signature-256` は共有秘密による HMAC-SHA256。 比較は必ず timing-safe で行う
 * (文字列比較だと一致長から秘密が漏れる)。 secret 未設定は「検証不能」であって
 * 「検証成功」ではないので、 呼び出し側は必ず拒否する。
 *
 * @implements spec/feature/github-issue-workflow.md — 契約
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: "secret_unset" | "signature_missing" | "signature_mismatch" };

export function githubSignature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export function verifyGithubSignature(input: {
  secret: string | null;
  header: string | null | undefined;
  body: string;
}): SignatureVerdict {
  if (input.secret === null || input.secret.trim() === "") return { ok: false, reason: "secret_unset" };
  const header = input.header?.trim();
  if (!header) return { ok: false, reason: "signature_missing" };
  const expected = Buffer.from(githubSignature(input.secret, input.body), "utf8");
  const actual = Buffer.from(header, "utf8");
  // 長さが違う時点で不一致だが、 timingSafeEqual は長さ違いで例外を投げるので先に落とす。
  if (expected.length !== actual.length) return { ok: false, reason: "signature_mismatch" };
  return timingSafeEqual(expected, actual) ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}
