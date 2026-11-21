/**
 * 指令ブリッジの入口判定 (spec/feature/agent-instructions-bridge.md CC-INST-INV-06 / INV-07)。
 *
 *  - 公開経由か: Host が公開ホストに一致するか、 Cloudflare Tunnel 由来のヘッダー
 *    (cf-ray / cf-connecting-ip / cf-access-jwt-assertion) があれば公開経由 (web-sso の isPublicRequest と同じ判定)。
 *  - 公開経由の要求は Cf-Access-Jwt-Assertion を CF Access の公開鍵で検証できたものだけ通す
 *    (CfAccessVerifier を再利用、 aud はこのブリッジ用 Access アプリ)。 team / aud が未設定なら公開経由は全部拒否。
 *  - 登録 (POST /v1/instructions) と状態確認 (GET /v1/instructions/:id) は公開経由を検証に関係なく拒否する。
 *
 * @implements spec/feature/agent-instructions-bridge.md — 入口判定
 */

import { isPublicRequest, type HeaderReader } from "../web-sso/policy.js";

export type RequestOrigin = "local" | "public";

export interface AccessVerifier {
  verify(assertion: string | undefined): Promise<unknown | null>;
}

export interface InstructionAccessGate {
  origin(header: HeaderReader): RequestOrigin;
  /** 公開経由の要求が CF Access を通ってきたことを確かめる。 */
  verifyPublic(header: HeaderReader): Promise<boolean>;
}

export function createInstructionAccessGate(options: { publicHost: string | null; verifier: AccessVerifier | null }): InstructionAccessGate {
  // 公開ホスト未設定でもトンネル由来ヘッダーで公開経由を捕まえるため、 一致しない値を置く。
  const host = options.publicHost?.trim().toLowerCase() || "\u0000";
  return {
    origin: (header) => (isPublicRequest(host, header) ? "public" : "local"),
    verifyPublic: async (header) => {
      if (!options.verifier) return false;
      const assertion = header("cf-access-jwt-assertion")?.trim() || undefined;
      return Boolean(await options.verifier.verify(assertion));
    },
  };
}
