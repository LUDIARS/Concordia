/**
 * Astra (codex) の相談の CODEX_HOME に Cc が書く hooks.json から呼ばれるフック
 * (spec/feature/tech-consultation.md §6、 spec/feature/usage-budgets.md §5.2)。
 *
 *   node tools/consult-codex-hook.mjs pre-tool       PreToolUse: シェルは公開リンクの取得コマンドだけを通し (Cc に聞かずに判定)、
 *                                                    続けて Cc のハーネス判定 (POST /v1/harness/gate)。
 *                                                    deny ならツールを止める (予算切れの usage-budget を含む)。
 *   node tools/consult-codex-hook.mjs session-start  SessionStart: transcript_path を Cc のセッションへ報告する。
 *
 * 相談は MCP を外しているので command 型で動く。 Cc のセッション id は起動 env の CONCORDIA_SESSION_ID。
 * Cc に届かない・判定に失敗したときはツールを止めない (Cc の不調で相談を止めない。 Claude のフックと同じ扱い)。
 * ただしシェルの制限 (取得コマンド以外を止める) は Cc に頼らず、 届かなくても止める。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { FETCH_LINK_SCRIPT_ENV, isAllowedFetchLinkCommand } from "./consult-fetch-link-command.mjs";

const DEFAULT_TIMEOUT_MS = 3000;

/** codex の PreToolUse 入力をハーネスの操作 1 件にする。 */
export function gateActionFrom(input) {
  const toolInput = input?.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const command = typeof toolInput.command === "string"
    ? toolInput.command
    : Array.isArray(toolInput.command) ? toolInput.command.join(" ") : undefined;
  return {
    tool: String(input?.tool_name ?? "unknown").slice(0, 64),
    ...(command ? { command: command.slice(0, 20000) } : {}),
    ...(typeof input?.cwd === "string" ? { cwd: input.cwd } : {}),
  };
}

const SHELL_LIKE_TOOLS = /^(bash|shell|local_shell|exec_command|unified_exec|container\.exec|apply_patch)$/i;

/**
 * 相談のシェルは公開リンクの取得コマンド 1 本だけ (CC-CONSULT-INV-07、 consult-fetch-link-command.mjs)。
 * Cc に届かなくても止める (fail-closed)。 シェル以外のツールは null (Cc の判定に任せる)。
 */
export function localShellVerdict(input, env = process.env) {
  const toolInput = input?.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const shellLike = toolInput.command !== undefined || SHELL_LIKE_TOOLS.test(String(input?.tool_name ?? ""));
  if (!shellLike) return null;
  if (isAllowedFetchLinkCommand(toolInput.command, env[FETCH_LINK_SCRIPT_ENV])) return null;
  return {
    decision: "deny",
    reason: "相談窓口で実行できるコマンドは公開リンクの取得だけです (consult-fetch-link スキルの形: node <取得スクリプト> '<URL>')。",
  };
}

/** Cc の判定を codex の PreToolUse の出力にする。 deny 以外は何も出さない (許可)。 */
export function preToolOutput(verdict) {
  if (verdict?.decision !== "deny") return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: String(verdict.reason || "Concordia のハーネス判定でツールを止めました。"),
    },
  };
}

export async function runConsultCodexHook({
  event, input, env = process.env, fetchImpl = fetch, write = (text) => process.stdout.write(text),
}) {
  if (event === "pre-tool") {
    // シェルの制限は Cc の判定より先に、 Cc が無くても効かせる。
    const local = preToolOutput(localShellVerdict(input, env));
    if (local) {
      write(`${JSON.stringify(local)}\n`);
      return;
    }
  }
  const sessionId = env.CONCORDIA_SESSION_ID?.trim();
  if (!sessionId || env.CONCORDIA_DISABLE === "1") return;
  const base = (env.CONCORDIA_URL ?? "http://127.0.0.1:11111").replace(/\/+$/, "");
  const timeout = Number(env.CONCORDIA_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const request = async (path, method, body) => {
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS),
      });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  if (event === "pre-tool") {
    const verdict = await request("/v1/harness/gate", "POST", {
      action: gateActionFrom(input), session_id: sessionId, hook: "consult-codex-pre-tool",
    });
    const output = preToolOutput(verdict);
    if (output) write(`${JSON.stringify(output)}\n`);
    return;
  }
  if (event === "session-start") {
    const transcriptPath = typeof input?.transcript_path === "string" ? input.transcript_path : null;
    if (transcriptPath) await request(`/v1/sessions/${encodeURIComponent(sessionId)}`, "PATCH", { transcript_path: transcriptPath });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = null;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { /* 入力が無くても何もせず抜ける。 */ }
  await runConsultCodexHook({ event: process.argv[2] ?? "noop", input }).catch((error) => {
    process.stderr.write(`[consult-codex-hook] ${String(error?.message ?? error)}\n`);
  });
}
