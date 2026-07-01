#!/usr/bin/env node
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const DEFAULT_URL = process.env.CONCORDIA_URL || "http://127.0.0.1:11111";
const QUEUE_PATH = process.env.CONCORDIA_COST_ONESHOT_QUEUE || join(process.cwd(), "logs", "cost-one-shot-queue.jsonl");

function usage() {
  process.stderr.write(
    "usage:\n" +
    "  node tools/cost-one-shot-client.mjs --payload payload.json\n" +
    "  node tools/cost-one-shot-client.mjs --json '{...}'\n" +
    "  node tools/cost-one-shot-client.mjs --flush\n",
  );
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function queue(payload) {
  await mkdir(dirname(QUEUE_PATH), { recursive: true });
  await appendFile(QUEUE_PATH, JSON.stringify(payload) + "\n", "utf8");
}

async function post(payload, baseUrl = DEFAULT_URL) {
  const res = await fetch(baseUrl.replace(/\/+$/, "") + "/v1/cost/one-shots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function loadPayload() {
  const rawJson = arg("--json");
  const payloadPath = arg("--payload");
  if (rawJson) return JSON.parse(rawJson);
  if (payloadPath) return JSON.parse(await readFile(payloadPath, "utf8"));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

async function flush({ silent = false } = {}) {
  let raw = "";
  try {
    raw = await readFile(QUEUE_PATH, "utf8");
  } catch {
    if (!silent) process.stdout.write(JSON.stringify({ ok: true, flushed: 0, remaining: 0 }) + "\n");
    return;
  }
  const pending = raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const failed = [];
  let flushed = 0;
  for (const payload of pending) {
    try {
      await post(payload);
      flushed++;
    } catch {
      failed.push(payload);
    }
  }
  if (failed.length === 0) {
    await writeFile(QUEUE_PATH, "", "utf8");
  } else {
    const tmp = QUEUE_PATH + ".tmp";
    await writeFile(tmp, failed.map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8");
    await rename(tmp, QUEUE_PATH);
  }
  if (!silent) process.stdout.write(JSON.stringify({ ok: failed.length === 0, flushed, remaining: failed.length }) + "\n");
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }
  if (process.argv.includes("--flush")) {
    await flush();
    return;
  }
  const payload = await loadPayload();
  if (!payload) {
    usage();
    process.exitCode = 2;
    return;
  }
  try {
    const result = await post(payload);
    await flush({ silent: true }).catch(() => undefined);
    process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
  } catch (err) {
    await queue(payload);
    process.stdout.write(JSON.stringify({ ok: false, queued: true, error: err.message }) + "\n");
  }
}

main().catch((err) => {
  process.stderr.write(`[cost-one-shot-client] ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
