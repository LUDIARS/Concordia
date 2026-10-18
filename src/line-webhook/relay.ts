/**
 * 転送先への POST (spec/feature/line-webhook-relay.md §転送)。
 *
 * fetch ではなく node:http(s) を使う。 Host ヘッダの上書きを確実に効かせるため
 * (fetch は Host を禁止ヘッダとして扱う実装がある)。 本文は受けたバイト列のまま送り、
 * 再送・キューイングはしない (LINE 側の再送に任せる)。
 *
 * @implements spec/feature/line-webhook-relay.md — 転送
 */

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { RelayHeaders } from "./relay-headers.js";

export const DEFAULT_RELAY_TIMEOUT_MS = 5_000;
/** 転送先の応答本文の上限。 LINE へ返すだけなので大きな本文は要らない。 */
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type RelayOutcome =
  | { kind: "response"; status: number; body: Buffer; contentType: string | null }
  | { kind: "unreachable"; reason: "timeout" | "connect" | "response_too_large" };

export interface RelayInput {
  url: string;
  headers: RelayHeaders;
  body: Uint8Array;
  timeoutMs?: number;
}

export function relayLineWebhook(input: RelayInput): Promise<RelayOutcome> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS;
  const url = new URL(input.url);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: RelayOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const req = send(url, { method: "POST", headers: input.headers }, (res) => {
      readResponse(res, (outcome) => {
        if (outcome.kind === "unreachable") req.destroy();
        finish(outcome);
      });
    });
    // 接続から応答本文の読み終わりまでを 1 本の期限で切る。
    const timer = setTimeout(() => {
      finish({ kind: "unreachable", reason: "timeout" });
      req.destroy();
    }, timeoutMs);
    req.on("error", () => finish({ kind: "unreachable", reason: "connect" }));
    req.end(input.body);
  });
}

function readResponse(res: IncomingMessage, done: (outcome: RelayOutcome) => void): void {
  const chunks: Buffer[] = [];
  let bytes = 0;
  res.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE_BYTES) {
      done({ kind: "unreachable", reason: "response_too_large" });
      res.destroy();
      return;
    }
    chunks.push(chunk);
  });
  res.on("end", () => {
    const contentType = res.headers["content-type"];
    done({
      kind: "response",
      status: res.statusCode ?? 502,
      body: Buffer.concat(chunks),
      contentType: typeof contentType === "string" ? contentType : null,
    });
  });
  res.on("error", () => done({ kind: "unreachable", reason: "connect" }));
}
