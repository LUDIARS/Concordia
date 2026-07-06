#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

const flags = parseArgs(process.argv.slice(2));
const concordiaUrl = (flags.concordiaUrl ?? process.env.CONCORDIA_URL ?? "http://127.0.0.1:11111").replace(/\/+$/, "");
const codexBin = flags.codexBin ?? process.env.CODEX_BIN ?? "codex";
const cwd = flags.cwd ?? process.cwd();
const timeoutMs = Number(process.env.CONCORDIA_TIMEOUT_MS ?? "1500");
const prompt = flags.promptFile
  ? readPromptFile(flags.promptFile)
  : flags.prompt.length > 0
    ? flags.prompt.join(" ")
    : readStdin();
const startedAt = Date.now();
const queuePath = process.env.CONCORDIA_COST_ONESHOT_QUEUE || join(process.cwd(), "logs", "cost-one-shot-queue.jsonl");

if (!prompt.trim()) {
  process.stderr.write("usage: concordia-codex-worker.mjs [--cd=DIR] [--model=MODEL] [--codex-bin=codex] <prompt>\n");
  process.exit(2);
}

// codex exec は非対話 (approval プロンプト無し)。 承認は無く、 sandbox ポリシーだけが
// model 生成コマンドの権限を決める。 `--ask-for-approval` は exec には無い引数なので渡さない。
// 委託で PR (git push / gh = network) を作るには danger-full-access が要る (呼び出し側が指定)。
const codexArgs = [
  "exec",
  "--json",
  "--color", "never",
  "--sandbox", flags.sandbox ?? "workspace-write",
  "--cd", cwd,
];
if (flags.model) codexArgs.push("--model", flags.model);
if (flags.reasoning) codexArgs.push("-c", `model_reasoning_effort="${flags.reasoning}"`);
codexArgs.push("-");

// Windows の npm グローバル codex は shim (codex/.cmd/.ps1) で native .exe を持たず、
// `spawn("codex", {shell:false})` は解決できず ENOENT になる。 shim が起動する
// codex.js を node で直接実行して回避する (shell を使わないので -c の quote も壊れない)。
const codexLaunch = resolveCodexLaunch(codexBin);
const child = spawn(codexLaunch.file, [...codexLaunch.prefix, ...codexArgs], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  shell: false,
  env: {
    ...process.env,
    CONCORDIA_PROVIDER: "codex-cli",
  },
});

let sessionId = null;
let transcriptPath = null;
let lastAssistantText = "";
let stdoutBuffer = "";
let stderr = "";
let pending = Promise.resolve();
let oneShotRecorded = false;

child.stdin.end(prompt, "utf8");

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  let idx;
  while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
    const line = stdoutBuffer.slice(0, idx).replace(/\r$/, "");
    stdoutBuffer = stdoutBuffer.slice(idx + 1);
    pending = pending.then(() => handleJsonLine(line));
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
  process.stderr.write(chunk);
});

child.on("error", (err) => {
  process.stderr.write(`[concordia-codex-worker] ${err.message}\n`);
  oneShotRecorded = true;
  queueOneShot({
    ts: startedAt,
    service: "concordia",
    provider: "codex",
    command: [codexBin, ...codexArgs].join(" "),
    model: flags.model ?? null,
    cwd,
    prompt,
    status: "error",
    exit_code: -1,
    duration_ms: Date.now() - startedAt,
    metadata: { error: err.message },
  }).catch(() => undefined);
  process.exitCode = 1;
});

child.on("close", async (code) => {
  if (stdoutBuffer.trim()) pending = pending.then(() => handleJsonLine(stdoutBuffer.trim()));
  await pending;
  if (sessionId) {
    await postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/event`, {
      kind: "codex-exit",
      payload: { code, stderr: stderr.slice(-1000) },
    });
    await postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {});
  }
  if (!oneShotRecorded) {
    oneShotRecorded = true;
    await postOneShot({
      ts: startedAt,
      service: "concordia",
      provider: "codex",
      command: [codexBin, ...codexArgs].join(" "),
      model: flags.model ?? null,
      cwd,
      prompt,
      status: code === 0 ? "ok" : "error",
      exit_code: code,
      duration_ms: Date.now() - startedAt,
      metadata: { sessionId, transcriptPath, stderr: stderr.slice(-1000) },
    });
  }
  if (lastAssistantText) process.stdout.write(lastAssistantText.trim() + "\n");
  process.exitCode = code ?? 1;
});

async function handleJsonLine(line) {
  if (!line.trim()) return;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }

  const meta = obj?.type === "session_meta" ? obj.payload : null;
  const metaSessionId = typeof meta?.session_id === "string" && meta.session_id
    ? meta.session_id
    : typeof meta?.id === "string" && meta.id
      ? meta.id
      : null;
  if (metaSessionId && !sessionId) {
    sessionId = metaSessionId;
    transcriptPath = inferTranscriptPath(meta, metaSessionId);
    await postJson("/v1/sessions", {
      id: sessionId,
      provider: "codex-cli",
      repo_path: meta.cwd ?? cwd,
      repo_origin: null,
      branch: null,
      host: hostname(),
      transcript_path: transcriptPath,
      metadata: {
        originator: meta.originator ?? "codex-exec",
        cli_version: meta.cli_version ?? null,
        model_provider: meta.model_provider ?? null,
      },
    });
    await postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/event`, {
      kind: "prompt",
      payload: { summary: prompt.slice(0, 200), length: prompt.length },
    });
    return;
  }

  const text = extractText(obj);
  if (text) lastAssistantText = text;
}

function inferTranscriptPath(meta, sessionId) {
  if (meta.transcript_path) return meta.transcript_path;
  if (!meta.timestamp || !sessionId) return null;
  const d = new Date(meta.timestamp);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `~/.codex/sessions/${yyyy}/${mm}/${dd}/rollout-${meta.timestamp.replace(/[:.]/g, "-")}-${sessionId}.jsonl`;
}

function extractText(obj) {
  const payload = obj?.payload ?? obj;
  const candidates = [payload.message, payload.content, payload.text, payload.delta, payload];
  for (const c of candidates) {
    const text = extractContentText(c);
    if (text) return text;
  }
  return "";
}

function extractContentText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractContentText).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  if (value.role && value.role !== "assistant") return "";
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return extractContentText(value.content);
  if (typeof value.text === "string") return value.text;
  return "";
}

async function postJson(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(`${concordiaUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    // Concordia must never block the worker.
  } finally {
    clearTimeout(timer);
  }
}

async function postOneShot(payload) {
  const ok = await postJsonChecked("/v1/cost/one-shots", payload);
  if (!ok) await queueOneShot(payload);
}

async function postJsonChecked(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${concordiaUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function queueOneShot(payload) {
  await mkdir(dirname(queuePath), { recursive: true });
  await appendFile(queuePath, JSON.stringify(payload) + "\n", "utf8");
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readPromptFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    process.stderr.write(`[concordia-codex-worker] failed to read --prompt-file=${path}: ${err.message}\n`);
    return "";
  }
}

/**
 * codex 実行コマンドを解決する。 明示パス (拡張子付き / 別名) はそのまま。 既定 "codex" は
 * POSIX ではそのまま、 Windows では npm shim が起動する codex.js を `node` で直接実行する
 * (Windows の codex.cmd は shell 無し spawn で ENOENT になるため)。
 * 戻り値: { file, prefix } → spawn(file, [...prefix, ...codexArgs])。
 */
function resolveCodexLaunch(codexBin) {
  if (codexBin && codexBin !== "codex") return { file: codexBin, prefix: [] };
  if (process.platform !== "win32") return { file: "codex", prefix: [] };
  try {
    const first = execSync("where codex", { encoding: "utf8" }).split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (first) {
      const js = join(dirname(first), "node_modules", "@openai", "codex", "bin", "codex.js");
      if (existsSync(js)) return { file: process.execPath, prefix: [js] };
    }
  } catch {
    // fall through to bare "codex"
  }
  return { file: "codex", prefix: [] };
}

function parseArgs(argv) {
  const out = { prompt: [] };
  for (const arg of argv) {
    if (arg === "--") continue;
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) {
      const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key === "cd" ? "cwd" : key] = m[2];
    } else {
      out.prompt.push(arg);
    }
  }
  return out;
}
