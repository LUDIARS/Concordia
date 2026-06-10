/**
 * delegation の local-LLM レーンで model="auto" のとき、Famulus の黒箱切り替え機に
 * モデルを選ばせる。Concordia は LLM を直接呼ばず、Famulus CLI (`famulus select`) を
 * shell するだけ (選択の Sonnet ワンショットは Famulus 内部 = 黒箱)。
 *
 * famulus select は stdout に model_id だけを 1 行で出す (source/理由は stderr)。
 * 失敗 (CLI 不在 / timeout / 空) は既定モデルにフォールバックする。
 * spec/feature/delegation.md §13。
 */

import { spawn } from "node:child_process";

const SELECT_TIMEOUT_MS = 70_000;
const DEFAULT_LOCAL_MODEL = "gemma4:12b";

export interface AutoModelHint {
  /** 対象プロジェクトのヒント (FT の project マッチに使う。例: repo basename)。 */
  project?: string | null;
  /** 対象リポの絶対パス (任意)。 */
  repo?: string | null;
  /** タスク要約 (任意、Sonnet の判断材料)。 */
  task?: string | null;
}

/**
 * model 文字列を解決する。"auto" でなければそのまま返す (空なら null)。
 * "auto" のときだけ `famulus select` を回して model_id を得る。
 */
export async function resolveLocalModel(
  model: string | null | undefined,
  hint: AutoModelHint = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const m = (model ?? "").trim();
  if (m.toLowerCase() !== "auto") return m || null;

  const args = ["select"];
  if (hint.project) args.push("--project", hint.project);
  if (hint.repo) args.push("--repo", hint.repo);
  if (hint.task) args.push("--task", hint.task);
  args.push("--fallback", DEFAULT_LOCAL_MODEL);

  return new Promise((resolve) => {
    // Windows は famulus が .cmd なので cmd.exe 経由 (shell:true の args 連結を避ける)。
    const isWin = process.platform === "win32";
    const file = isWin ? env.ComSpec ?? "cmd.exe" : "famulus";
    const cliArgs = isWin ? ["/d", "/s", "/c", "famulus", ...args] : args;

    let child;
    try {
      child = spawn(file, cliArgs, { env });
    } catch {
      resolve(DEFAULT_LOCAL_MODEL);
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve(DEFAULT_LOCAL_MODEL);
    }, SELECT_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve(DEFAULT_LOCAL_MODEL); });
    child.on("close", () => {
      clearTimeout(timer);
      // stdout は model_id だけ。改行除去 + 最終非空行。
      const line = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
      resolve(line || DEFAULT_LOCAL_MODEL);
    });
  });
}
