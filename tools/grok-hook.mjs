#!/usr/bin/env node
/** @implements CC-GROK-HOOK GHK-01/02 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runConcordiaHook } from "./concordia-hook-runtime.mjs";
import { grokDenyResponse, isGrokHarnessTool, toClaudeHookInput } from "./grok-hook-mapping.mjs";
import { runSupervisor } from "./harness-hook-supervisor.mjs";

export async function gateGrokToolCall({ grok, env = process.env, supervise = runSupervisor }) {
  if (env.CONCORDIA_DISABLE === "1") return null;
  const ctx = toClaudeHookInput(grok);
  if (!ctx.tool_name) return grokDenyResponse("[grok-hook] Missing PreToolUse tool name.");
  if (!isGrokHarnessTool(ctx.tool_name)) return null;
  const target = ctx.tool_name === "Bash" ? ctx.tool_input.command : ctx.tool_input.file_path;
  if (typeof target !== "string" || !target.trim()) {
    return grokDenyResponse("[grok-hook] Missing command or file path for a protected tool.");
  }
  const runtime = env.CONCORDIA_HARNESS_RUNTIME;
  const config = env.CONCORDIA_HARNESS_CONFIG;
  if (!runtime || !config || !isAbsolute(runtime) || !isAbsolute(config)
    || !existsSync(join(runtime, "harness/supervisor-cli.js")) || !existsSync(config)) {
    return grokDenyResponse("[harness-supervisor] Configure absolute CONCORDIA_HARNESS_RUNTIME and CONCORDIA_HARNESS_CONFIG paths before enabling the Grok hook.");
  }
  try {
    const { code, stderr } = await supervise({
      runtime, config, env,
      input: JSON.stringify({ tool_name: ctx.tool_name, tool_input: ctx.tool_input, cwd: ctx.cwd, hook_event_name: "PreToolUse" }),
    });
    return code === 0 ? null : grokDenyResponse(stderr || `[harness-supervisor] exited with code ${code}`);
  } catch (error) {
    return grokDenyResponse(`[harness-supervisor] ${String(error?.message ?? error)}`);
  }
}

export async function observeGrokEvent({ event, grok, env = process.env, run = runConcordiaHook }) {
  const ctx = toClaudeHookInput(grok);
  const options = { ctx, provider: "grok-cli", env, output: () => {} };
  if (event === "prompt") {
    if (ctx.prompt) await run({ ...options, event: "prompt" });
    return;
  }
  if (!ctx.tool_name) return;
  const failed = event === "post-tool-failure" || ctx.hook_event_name === "PostToolUseFailure";
  await run({ ...options, event: failed ? "tool-failure" : "tool-result" });
  if (!failed && ctx.tool_name !== "Bash" && isGrokHarnessTool(ctx.tool_name) && ctx.tool_input.file_path) {
    await run({ ...options, event: "edit" });
  }
}

export async function runGrokHookCli({
  argv = process.argv.slice(2), env = process.env,
  readInput = () => readFileSync(0, "utf8"), write = (text) => process.stdout.write(text),
} = {}) {
  const [event, ...args] = argv;
  if (env.CONCORDIA_DISABLE === "1") return;
  const flags = Object.fromEntries(args.flatMap((arg) => {
    const match = /^--(runtime|config)=(.*)$/.exec(arg);
    return match ? [[match[1], match[2]]] : [];
  }));
  env = {
    ...env,
    CONCORDIA_HARNESS_RUNTIME: flags.runtime ?? env.CONCORDIA_HARNESS_RUNTIME,
    CONCORDIA_HARNESS_CONFIG: flags.config ?? env.CONCORDIA_HARNESS_CONFIG,
  };
  let grok;
  try {
    grok = JSON.parse(readInput());
  } catch {
    if (event === "pre-tool") write(grokDenyResponse("[grok-hook] Hook input was not valid JSON."));
    return;
  }
  if (event === "pre-tool") {
    const response = await gateGrokToolCall({ grok, env });
    if (response) write(response);
    return;
  }
  if (event === "post-tool" || event === "post-tool-failure" || event === "prompt") {
    await observeGrokEvent({ event, grok, env });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runGrokHookCli().catch((error) => {
    const reason = "[grok-hook] " + String(error?.message ?? error);
    if (process.argv[2] === "pre-tool") process.stdout.write(grokDenyResponse(reason));
    else process.stderr.write(reason + "\n");
  });
}
