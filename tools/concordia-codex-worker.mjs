#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

const flags = parseArgs(process.argv.slice(2));
const concordiaUrl = (flags.concordiaUrl ?? process.env.CONCORDIA_URL ?? "http://127.0.0.1:11111").replace(/\/+$/, "");
const codexBin = flags.codexBin ?? process.env.CODEX_BIN ?? "codex";
const cwd = flags.cwd ?? process.cwd();
const timeoutMs = Number(process.env.CONCORDIA_TIMEOUT_MS ?? "1500");
const prompt = flags.prompt.length > 0 ? flags.prompt.join(" ") : readStdin();

if (!prompt.trim()) {
  process.stderr.write("usage: concordia-codex-worker.mjs [--cd=DIR] [--model=MODEL] [--codex-bin=codex] <prompt>\n");
  process.exit(2);
}

const codexArgs = [
  "exec",
  "--json",
  "--color", "never",
  "--ask-for-approval", flags.approval ?? "never",
  "--sandbox", flags.sandbox ?? "workspace-write",
  "--cd", cwd,
];
if (flags.model) codexArgs.push("--model", flags.model);
codexArgs.push("-");

const child = spawn(codexBin, codexArgs, {
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
  if (meta?.id && !sessionId) {
    sessionId = meta.id;
    transcriptPath = inferTranscriptPath(meta);
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

function inferTranscriptPath(meta) {
  if (meta.transcript_path) return meta.transcript_path;
  if (!meta.timestamp || !meta.id) return null;
  const d = new Date(meta.timestamp);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `~/.codex/sessions/${yyyy}/${mm}/${dd}/rollout-${meta.timestamp.replace(/[:.]/g, "-")}-${meta.id}.jsonl`;
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

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
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
