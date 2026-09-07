/** @implements spec/feature/project-harness-policy.md — standalone hook, no Cc process/DB dependency */
import { readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync, realpathSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { evaluateAction, type GateVerdict } from "./session-gate.js";
import type { HarnessAction } from "./predicates.js";
import { evaluateCachedAction, recoveryAllowed, usableSnapshot } from "./supervisor-policy.js";
import { needsDddEvidence, DDD_INSTRUCTION } from "./project-policy.js";
import { hasDddEvidence } from "./ddd-evidence.js";

interface Config {
  catalog: string;
  stateDir: string;
  recoveryRoots: string[];
  recoveryCommands: string[];
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function catalogPort(path: string): number {
  const text = readFileSync(path, "utf8");
  const section = text.split(/^  - code: /m).find((part) => /^concordia\s*\r?\n/.test(part));
  const port = Number(section?.match(/^    port: (\d+)\s*$/m)?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Concordia port missing from Excubitor catalog");
  return port;
}

async function online(port: number, payload: unknown): Promise<{ status: number; body: unknown } | null> {
  return new Promise((done) => {
    let settled = false;
    const finish = (value: { status: number; body: unknown } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    const req = request({ host: "127.0.0.1", port, path: "/v1/harness/gate", method: "POST", agent: false,
      headers: { "content-type": "application/json" } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
        if (text.length > 1_000_000) { finish({ status: 502, body: null }); req.destroy(); }
      });
      response.on("error", () => finish(null));
      response.on("end", () => {
        try { finish({ status: response.statusCode ?? 502, body: JSON.parse(text) }); }
        catch { finish({ status: response.statusCode ?? 502, body: null }); }
      });
    });
    const timer = setTimeout(() => { finish(null); req.destroy(); }, 2000);
    req.on("error", () => finish(null));
    req.end(JSON.stringify(payload));
  });
}

function reject(reason: string): GateVerdict {
  return { decision: "deny", blocked: true, reason, hits: [] };
}

/** Resolve the nearest existing parent so symlink/junction escapes cannot use recovery permission. */
function physicalPath(path: string): string {
  const tail: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error("Cannot resolve edit target");
    tail.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return join(realpathSync(current), ...tail);
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Usage: node supervisor-cli.js <config.json>");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Config;
  if (typeof config.catalog !== "string" || typeof config.stateDir !== "string"
    || ![config.recoveryRoots, config.recoveryCommands].every((values) => Array.isArray(values) && values.every((value) => typeof value === "string"))) {
    throw new Error("Invalid supervisor configuration");
  }
  const port = catalogPort(config.catalog);
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 1_000_000) throw new Error("Hook input exceeds limit");
  }
  const hook = JSON.parse(input) as { tool_name: string; cwd?: string; tool_input?: { command?: string; file_path?: string; notebook_path?: string } };
  if (!hook.tool_name) throw new Error("Missing tool_name");
  const filePath = hook.tool_input?.file_path ?? hook.tool_input?.notebook_path;
  const cwd = hook.cwd ?? process.cwd();
  const target = filePath ? physicalPath(resolve(cwd, filePath)) : undefined;
  const probe = target ? dirname(target) : cwd;
  let existingProbe = probe;
  while (!existsSync(existingProbe)) existingProbe = dirname(existingProbe);
  const root = realpathSync(git(existingProbe, ["rev-parse", "--show-toplevel"]));
  const branch = git(root, ["branch", "--show-current"]);
  const action: HarnessAction = { tool: hook.tool_name, command: hook.tool_input?.command, filePath: target,
    cwd: root, branch, isWorktree: git(root, ["rev-parse", "--git-dir"]) !== git(root, ["rev-parse", "--git-common-dir"]) };
  const sessionId = process.env.LICTOR_SESSION_ID ?? "";
  mkdirSync(config.stateDir, { recursive: true });
  let origin: string;
  try { origin = git(root, ["config", "--get-regexp", "^remote\\..*\\.url$"]); }
  catch (error) {
    // git config exits 1 when no remote URL exists; other failures must remain visible.
    if ((error as { status?: number }).status !== 1) throw error;
    origin = "";
  }
  const cacheKey = createHash("sha256").update(`${root}\n${origin}\n${sessionId}`).digest("hex");
  const cachePath = join(config.stateDir, `${cacheKey}.json`);
  const response = await online(port, { action, session_id: sessionId, hook: "supervisor" });
  let mode = "online";
  let verdict: GateVerdict;
  if (response && response.status < 500) {
    const body = response.body as (GateVerdict & { local_policy?: unknown }) | null;
    if (response.status !== 200 || !body || !["allow", "warn", "deny"].includes(body.decision)
      || typeof body.blocked !== "boolean" || typeof body.reason !== "string") {
      verdict = reject("Cc returned an invalid gate response; offline permission was not substituted.");
    } else {
      verdict = { ...body, blocked: body.blocked || body.decision === "deny" };
      if (usableSnapshot(body.local_policy, action, sessionId, Date.now())) {
        const temporary = `${cachePath}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify(body.local_policy), "utf8");
        renameSync(temporary, cachePath);
      }
    }
  } else {
    let cached: unknown;
    // 破損して読めない場合も「存在した」ことは権限判定に効かせる。 読めないキャッシュを
    // 未取得と同一視すると、 問診など制限の強い session が復旧権限へ格上げされうる。
    const hadCacheFile = existsSync(cachePath);
    if (hadCacheFile) {
      try { cached = JSON.parse(readFileSync(cachePath, "utf8")); }
      catch { process.stderr.write("[harness-supervisor] Invalid cache; recovery-only mode.\n"); }
    }
    if (usableSnapshot(cached, action, sessionId, Date.now())) {
      mode = "cached";
      verdict = evaluateCachedAction(action, cached);
      if (needsDddEvidence(action, cached.policy) && !hasDddEvidence(root, target!)) verdict = reject(DDD_INSTRUCTION);
      if (verdict.blocked && recoveryAllowed(action, config.recoveryRoots.map((path) => realpathSync(path)), config.recoveryCommands)) {
        // Recovery relaxes ONLY the contract prerequisites that a stale/absent Cc cannot
        // re-confirm. Every other cached restriction (inquiry read-only, team worktree,
        // main-push allowlist, strong-model gate, vibes scope) stays authoritative, so we
        // filter the existing verdict rather than re-evaluating against a weaker set.
        const RECOVERABLE = new Set(["contract-incomplete", "plan-unapproved"]);
        const remaining = verdict.hits.filter((hit) => !RECOVERABLE.has(hit.rule));
        if (remaining.length < verdict.hits.length) {
          mode = "recovery";
          const worst = remaining.some((hit) => hit.decision === "deny") ? "deny"
            : remaining.some((hit) => hit.decision === "warn") ? "warn" : "allow";
          verdict = { decision: worst, hits: remaining, blocked: worst === "deny",
            reason: remaining.length === 0 ? "Recovery scope: contract prerequisites deferred until Cc is reachable."
              : remaining.map((hit) => `[${hit.rule}] ${hit.reason}`).join(" / ") };
        }
      }
      if (!verdict.blocked) {
        cached.editedFiles = [...new Set([...cached.editedFiles, ...(target ? [target] : [])])];
        cached.editedRepos = [...new Set([...cached.editedRepos, root])];
        // Never renew capturedAt offline: only a fresh Cc response extends the lease.
        const temporary = `${cachePath}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify(cached), "utf8");
        renameSync(temporary, cachePath);
      }
    } else if (hadCacheFile) {
      // キャッシュはあるが照合に失敗した (期限切れ・別 session/branch・破損)。 どの権限で
      // 起動された session か確認できないため、 復旧権限へ格上げしない。
      mode = "recovery";
      verdict = reject("Cached policy does not match this session/branch or has expired. Reconnect to Cc to refresh it.");
    } else {
      mode = "recovery";
      verdict = recoveryAllowed(action, config.recoveryRoots.map((path) => realpathSync(path)), config.recoveryCommands)
        ? evaluateAction(action) : reject("Cc unavailable and no current policy cache. Only configured recovery roots and commands are permitted.");
    }
  }
  // No command text, file contents, or prompt payload in the offline audit.
  appendFileSync(join(config.stateDir, "audit.jsonl"), JSON.stringify({ ts: Date.now(), mode, decision: verdict.decision,
    project: cacheKey, tool: action.tool, rules: verdict.hits?.map((hit) => hit.rule) ?? [] }) + "\n", "utf8");
  if (mode !== "online") process.stderr.write(`[harness-supervisor] ${mode} mode: ${verdict.reason}\n`);
  if (verdict.blocked) {
    process.stderr.write(`[harness-supervisor] ${verdict.reason}\n`);
    process.exitCode = 2;
  } else if (verdict.decision === "warn") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: verdict.reason } }));
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`[harness-supervisor] ${error instanceof Error ? error.message : "Unexpected failure"}\n`);
  process.exitCode = 2;
});
