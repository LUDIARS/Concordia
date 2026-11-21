#!/usr/bin/env node
/**
 * Antigravity CLI (agy) の hooks.json から呼ばれ、 Concordia のハーネスへつなぐ
 * (spec/feature/agy-harness-hook.md)。
 *
 *   node tools/agy-hook.mjs pre-tool     PreToolUse   — ハーネスのゲート (supervisor) に通し、 拒否なら止める
 *   node tools/agy-hook.mjs post-tool    PostToolUse  — ツールの結果を Concordia に観測させる
 *   node tools/agy-hook.mjs prompt       PreInvocation — 人の指示を Concordia に観測させる (ターンの最初だけ)
 *
 * stdout は agy が応答として読むので、 止めるときの JSON 以外は何も出さない。
 * ゲートは Claude Code と同じ supervisor (CONCORDIA_HARNESS_RUNTIME / CONCORDIA_HARNESS_CONFIG) を使う。
 * 設定が欠けていたら通さずに止める (無言で素通しにしない)。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runConcordiaHook } from "./concordia-hook-runtime.mjs";
import { agyDenyResponse, isAgyToolFailure, isGatedAgyTool, toClaudeHookInput } from "./agy-hook-mapping.mjs";

const PROVIDER = "antigravity-cli";
const SUPERVISOR_TIMEOUT_MS = 30_000;

/** supervisor を起動して判定を受け取る。 { code, stderr }。 */
function runSupervisor({ runtime, config, input, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(runtime, "harness/supervisor-cli.js"), config], {
      env, windowsHide: true, shell: false, stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stderr: `harness supervisor did not answer within ${SUPERVISOR_TIMEOUT_MS} ms` });
    }, SUPERVISOR_TIMEOUT_MS);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ code: null, stderr: error.message }));
    child.on("exit", (code) => finish({ code, stderr }));
    child.stdin.on("error", () => { /* supervisor が先に終わった。 exit で結果を受け取る */ });
    child.stdin.end(input);
  });
}

/** PreToolUse: 止めるなら agy への応答 (JSON 文字列)、 通すなら null。 */
export async function gateAgyToolCall({ agy, env = process.env, supervise = runSupervisor }) {
  if (env.CONCORDIA_DISABLE === "1") return null;
  if (!isGatedAgyTool(agy?.toolCall?.name)) return null;
  const runtime = env.CONCORDIA_HARNESS_RUNTIME;
  const config = env.CONCORDIA_HARNESS_CONFIG;
  if (!runtime || !config || !isAbsolute(runtime) || !isAbsolute(config)
    || !existsSync(join(runtime, "harness/supervisor-cli.js")) || !existsSync(config)) {
    return agyDenyResponse("[harness-supervisor] Configure absolute CONCORDIA_HARNESS_RUNTIME and CONCORDIA_HARNESS_CONFIG paths before enabling the agy hook.");
  }
  const { code, stderr } = await supervise({ runtime, config, input: JSON.stringify(toClaudeHookInput(agy)), env });
  if (code === 0) return null;
  // supervisor は拒否を exit 2 + stderr で返す。 それ以外の異常終了も通さない (fail-closed)。
  return agyDenyResponse(stderr || `[harness-supervisor] exited with code ${code}`);
}

/** PostToolUse / PreInvocation: Concordia の観測 hook に渡す。 agy へは何も返さない。 */
export async function observeAgyEvent({ event, agy, env = process.env, run = runConcordiaHook }) {
  const ctx = toClaudeHookInput(agy);
  const options = { ctx, provider: PROVIDER, env, output: () => { /* agy の応答に混ぜない */ } };
  if (event === "prompt") {
    // PreInvocation はモデル呼び出しのたびに来る。 人の指示はターンの最初 (invocationNum 0) だけ。
    if (agy?.invocationNum !== 0 || !ctx.prompt) return;
    await run({ ...options, event: "prompt" });
    return;
  }
  if (!ctx.tool_name) return;
  await run({ ...options, event: isAgyToolFailure(agy) ? "tool-failure" : "tool-result" });
  if (isGatedAgyTool(agy.toolCall.name) && ctx.tool_input?.file_path) await run({ ...options, event: "edit" });
}

export async function runAgyHookCli({
  argv = process.argv.slice(2), env = process.env,
  readInput = () => readFileSync(0, "utf8"), write = (text) => process.stdout.write(text),
} = {}) {
  const event = argv[0];
  // agy は Claude Code の settings.json の env を持たないので、 hooks.json の引数でも渡せるようにする。
  const flags = Object.fromEntries(argv.slice(1).flatMap((arg) => {
    const match = /^--(runtime|config)=(.+)$/.exec(arg);
    return match ? [[match[1], match[2]]] : [];
  }));
  env = {
    ...env,
    ...(flags.runtime ? { CONCORDIA_HARNESS_RUNTIME: flags.runtime } : {}),
    ...(flags.config ? { CONCORDIA_HARNESS_CONFIG: flags.config } : {}),
  };
  let agy;
  try { agy = JSON.parse(readInput()); }
  catch {
    // 入力が読めないツール呼び出しは判定できないので止める。 観測だけの event は黙って抜ける。
    if (event === "pre-tool" && env.CONCORDIA_DISABLE !== "1") write(agyDenyResponse("[agy-hook] hook input was not valid JSON."));
    return;
  }
  if (event === "pre-tool") {
    const response = await gateAgyToolCall({ agy, env });
    if (response) write(response);
    return;
  }
  if (event === "post-tool" || event === "prompt") await observeAgyEvent({ event, agy, env });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAgyHookCli().catch((error) => {
    process.stderr.write("[agy-hook] " + String(error?.message ?? error) + "\n");
    // ゲートの途中で落ちたら通さない。
    if (process.argv[2] === "pre-tool") process.stdout.write(agyDenyResponse("[agy-hook] " + String(error?.message ?? error)));
  });
}
