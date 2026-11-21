#!/usr/bin/env node
/**
 * セッションのプランを Concordia へ送る CLI (spec/feature/session-plan-discord.md)。
 * プランを自分で持たないエージェント (Antigravity CLI など) が、 コマンド実行ツールから呼ぶ。
 *
 *   node tools/session-plan.mjs update  --file=<plan.json> | --json='<JSON>'
 *   node tools/session-plan.mjs wrap-up --file=<recap.json> | --json='<JSON>'
 *
 * 入力はデスクトップの Claude アプリの update_plan / wrap_up と同じ形。 Concordia が直前の状態に当てて解釈する。
 * セッションは env (CONCORDIA_SESSION_ID → LICTOR_SESSION_ID) で決める。
 * 送れなかった・入力を受け付けられなかったときは非 0 で終わり、 理由を 1 行 stderr へ出す (無言で成功にしない)。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { postSessionEvent } from "./concordia-hook-runtime.mjs";

/** Concordia の src/session-plan/plan-state.ts の SESSION_PLAN_EVENT_KIND と同じ値。 */
export const SESSION_PLAN_EVENT_KIND = "desktop_plan";

const COMMANDS = new Map([["update", "update_plan"], ["wrap-up", "wrap_up"]]);
const USAGE = "使い方: node tools/session-plan.mjs <update|wrap-up> --file=<input.json> | --json='<JSON>'";

const REASONS = {
  disabled: "CONCORDIA_DISABLE=1 なので送っていません。",
  no_session: "セッション ID がありません (CONCORDIA_SESSION_ID / LICTOR_SESSION_ID が未設定)。 Lictor 経由で起動したセッションから呼んでください。",
  concordia_unreachable: "Concordia に接続できませんでした。",
  session_not_active: "Concordia にこのセッションの active な登録がありません。",
  rejected: "Concordia がイベントを受け付けませんでした。",
  invalid_plan: "プランの入力の形が違います (update は items / advance / done / start、 wrap-up は recap が必須)。",
};

function parseFlags(args) {
  return Object.fromEntries(args.flatMap((arg) => {
    const match = /^--(file|json)=([\s\S]*)$/.exec(arg);
    return match ? [[match[1], match[2]]] : [];
  }));
}

/** 引数から送る payload を組み立てる。 { payload } | { error }。 */
export function buildPlanPayload(argv, readFile = (path) => readFileSync(path, "utf8")) {
  const tool = COMMANDS.get(argv[0]);
  if (!tool) return { error: USAGE };
  const flags = parseFlags(argv.slice(1));
  let text;
  try {
    text = flags.file !== undefined ? readFile(flags.file) : flags.json;
  } catch (error) {
    return { error: `入力ファイルを読めませんでした: ${String(error?.message ?? error)}` };
  }
  if (text === undefined) return { error: USAGE };
  let input;
  try { input = JSON.parse(text.replace(/^﻿/, "")); }
  catch { return { error: "入力が JSON ではありません。" }; }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { error: "入力は JSON のオブジェクトにしてください。" };
  return { payload: { tool, input } };
}

/** CLI 本体。 終了コードを返す (0 = 送れた)。 */
export async function runSessionPlanCli({
  argv = process.argv.slice(2), env = process.env, fetchImpl = fetch,
  readFile, stdout = (text) => process.stdout.write(text), stderr = (text) => process.stderr.write(text),
} = {}) {
  const built = buildPlanPayload(argv, readFile);
  if (built.error) { stderr(`[session-plan] ${built.error}\n`); return 2; }
  const sessionId = env.CONCORDIA_SESSION_ID || env.LICTOR_SESSION_ID || null;
  const result = await postSessionEvent({ sessionId, kind: SESSION_PLAN_EVENT_KIND, payload: built.payload, env, fetchImpl });
  if (!result.ok) { stderr(`[session-plan] ${REASONS[result.reason] ?? result.reason}\n`); return 1; }
  // 受け付けたが解釈できなかった (plan が null) のは、 送り直しても同じなので入力の誤りとして返す。
  const plan = result.body?.plan;
  if (!plan) { stderr(`[session-plan] ${REASONS.invalid_plan}\n`); return 2; }
  stdout(`[session-plan] ${plan.status ?? "プランなし"}${plan.posted ? " (投稿しました)" : " (変化なし・投稿なし)"}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runSessionPlanCli().catch((error) => {
    process.stderr.write("[session-plan] " + String(error?.message ?? error) + "\n");
    return 1;
  });
}
