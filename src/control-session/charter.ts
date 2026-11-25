/**
 * 管制セッションの作業場所と役割文書 (CONTROL.md) の準備。
 *
 * @implements spec/feature/control-session.md — 1. singleton の起動と復旧
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CONTROL_DIR_NAME = ".concordia-control";
export const CONTROL_CHARTER_FILE = "CONTROL.md";
export const CONTROL_START_PROMPT = "CONTROL.md を読み、管制セッションとして待機してください。";

export function renderControlCharter(input: { concordiaUrl: string; generation: number }): string {
  return [
    `# 管制セッション (第 ${input.generation} 世代)`,
    "",
    "あなたは Concordia (Cc) の管制セッションです。Cc の全セッションを統括し、止まった作業へ追加指示を出します。",
    "Cc が同時に 1 つだけ動かしています。終了するよう案内が届いたら、すぐに作業を終えて終了してください。",
    "",
    "## 受け取るもの",
    "- `[管制巡回]` で始まる要約: 自動確認でも作業状態が変わらないセッションの一覧。返信は不要です。",
    "- 各セッションの会話や履歴は届きません。必要なときだけ進捗ボードを読みます。",
    "",
    "## 使ってよい API (Cc、loopback)",
    `- GET ${input.concordiaUrl}/v1/control/board — 進捗ボード (各セッションの最新 1 行)`,
    `- POST ${input.concordiaUrl}/v1/instructions/desk-requests — 新しい依頼を登録する。JSON に session_id (自分)、request_id (再送時も同一)、body、分かる場合は project (略号) を含める。`,
    `- POST ${input.concordiaUrl}/v1/control/instructions — 追加指示 \`{"from_session_id":"<あなたの session id>","targets":["<session id>"],"text":"<指示>"}\``,
    "  日本語の本文はファイルに書いて送ってください (シェルへの直書きは文字化けします)。",
    "",
    "## 追加指示の決め方",
    "- 新しい依頼は依頼窓口へ登録し、進行中の作業を再開するための指示は既存の追加指示 API を使います。",
    "- 要約とボードから、そのセッションが自力で進められる次の一手が分かるときだけ、短く具体的に指示します。",
    "- 人間の判断が要ること・許可の無い操作 (マージ・反映・再起動・削除など) は指示しません。Cc も送らない条件を確かめます。",
    "- 同じセッションへ同じ内容を繰り返し送らないでください。",
    "",
    "## してはいけないこと",
    "- リポジトリの編集・コミット・PR 提出・サービス操作。管制は指示を出すだけです。",
    "- 審査ゲートや人間判断待ちを回避させる指示。",
  ].join("\n");
}

/** 作業場所を用意して役割文書を書く。作業場所のパスを返す。 */
export async function prepareControlWorkspace(input: {
  workspaceRoot: string; concordiaUrl: string; generation: number;
}): Promise<string> {
  const dir = join(input.workspaceRoot, CONTROL_DIR_NAME);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, CONTROL_CHARTER_FILE), renderControlCharter(input), "utf8");
  return dir;
}
