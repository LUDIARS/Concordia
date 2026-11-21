/**
 * AI プレイテスト感想の受け口の鍵の判定 (spec/feature/playtest-review-notify.md — 認証)。
 *
 * 受け口専用の鍵 (`playtest_notify.intake_token`) が設定されていれば、 `x-excubitor-token` がそれと一致するときだけ通す。
 * 比較は定数時間で、 長さが違っても早く返らない (両辺を SHA-256 にしてから比べる)。
 * 鍵が設定されていなければ従来どおりの判定 (デプロイ通知と共有の鍵、 無ければ loopback 運用だけ) に任せる。
 * 鍵が保存されているのに読めない (secret-box の鍵の入れ替え等) ときは、 未設定とみなさず全て断る (CC-PLAYTEST-INV-07)。
 *
 * @implements spec/feature/playtest-review-notify.md — 認証
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** 受け口専用の鍵の設定キー (schema_meta、 secret-box で暗号化)。 */
export const PLAYTEST_INTAKE_TOKEN_SETTING = "playtest_notify.intake_token";

/** 受け口専用の鍵の状態。 値そのものは判定の外へ出さない。 */
export type PlaytestIntakeToken =
  | { kind: "unset" }
  | { kind: "set"; value: string }
  | { kind: "unreadable" };

export type PlaytestReviewAuthDecision =
  | { allowed: true }
  | { allowed: false; reason: "missing" | "mismatch" | "unreadable" | "legacy_rejected" };

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** 提示された値と鍵を定数時間で比べる。 長さの違いも比較時間から漏らさない。 */
export function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * 受け口の鍵を判定する。 `legacy` は専用の鍵が未設定のときだけ呼ぶ従来の判定。
 */
export function decidePlaytestReviewAuth(input: {
  presented: string | undefined;
  intakeToken: PlaytestIntakeToken;
  legacy: (presented: string | undefined) => boolean;
}): PlaytestReviewAuthDecision {
  const { presented, intakeToken } = input;
  if (intakeToken.kind === "unreadable") return { allowed: false, reason: "unreadable" };
  if (intakeToken.kind === "unset") return input.legacy(presented) ? { allowed: true } : { allowed: false, reason: "legacy_rejected" };
  if (presented === undefined || presented === "") return { allowed: false, reason: "missing" };
  return tokenMatches(presented, intakeToken.value) ? { allowed: true } : { allowed: false, reason: "mismatch" };
}

/** 設定の読み出し (store.get) を鍵の状態へ写す。 空文字は未設定、 読み出しの失敗は「読めない」。 */
export function readPlaytestIntakeToken(read: () => string | null): PlaytestIntakeToken {
  let value: string | null;
  try {
    value = read();
  } catch {
    return { kind: "unreadable" };
  }
  return value === null || value === "" ? { kind: "unset" } : { kind: "set", value };
}
