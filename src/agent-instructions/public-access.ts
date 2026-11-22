/**
 * 指令ブリッジの入口判定 (spec/feature/agent-instructions-bridge.md CC-INST-INV-06 / INV-07)。
 *
 *  - 公開経由か: Host が公開ホストに一致するか、 Cloudflare Tunnel 由来のヘッダー
 *    (cf-ray / cf-connecting-ip / cf-access-jwt-assertion) があれば公開経由 (web-sso の isPublicRequest と同じ判定)。
 *  - 公開経由の要求は、 専用の鍵 (`x-excubitor-token`、 無ければ `Authorization`) が一致したものだけ通す (instruction-token.ts)。
 *    Cloudflare Access はサービストークンを単一ヘッダー (Authorization) で通し、 Cc は同じ値を鍵として確かめる。
 *    Access の JWT は鍵の代わりにならない。
 *  - 登録 (POST /v1/instructions) と状態確認 (GET /v1/instructions/:id) は公開経由を鍵に関係なく拒否する。
 *
 * @implements spec/feature/agent-instructions-bridge.md — 入口判定
 */

import { isPublicRequest, type HeaderReader } from "../web-sso/policy.js";
import {
  decideInstructionToken,
  pickPresentedInstructionToken,
  type InstructionIntakeToken,
  type InstructionTokenDecision,
} from "./instruction-token.js";

export type RequestOrigin = "local" | "public";

export interface InstructionAccessGate {
  origin(header: HeaderReader): RequestOrigin;
  /** 公開経由の要求が専用の鍵を持っているかを判定する。 */
  authorizePublic(header: HeaderReader): InstructionTokenDecision;
}

export function createInstructionAccessGate(options: { publicHost: string | null; readToken: () => InstructionIntakeToken }): InstructionAccessGate {
  // 公開ホスト未設定でもトンネル由来ヘッダーで公開経由を捕まえるため、 一致しない値を置く。
  const host = options.publicHost?.trim().toLowerCase() || "\u0000";
  return {
    origin: (header) => (isPublicRequest(host, header) ? "public" : "local"),
    // 鍵は要求ごとに読む (設定画面で差し替えたら再起動なしで古い鍵を無効にする)。
    authorizePublic: (header) => decideInstructionToken(pickPresentedInstructionToken(header), options.readToken()),
  };
}
