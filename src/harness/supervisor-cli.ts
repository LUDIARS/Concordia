/** @implements spec/feature/project-harness-policy.md — standalone hook, no Cc process/DB dependency */
import { readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync, realpathSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { evaluateAction, type GateVerdict } from "./session-gate.js";
import { homedir, tmpdir } from "node:os";
import { commonRootOf, isEditTool, type HarnessAction } from "./predicates.js";
import { isClaudeWorkArea, type WorkAreaBases } from "./work-area.js";
import { evaluateCachedAction, recoveryAllowed, snapshotUnusableReason, usableSnapshot } from "./supervisor-policy.js";
import { needsDddEvidence, DDD_INSTRUCTION } from "./project-policy.js";
import { hasDddEvidence } from "./ddd-evidence.js";
import { queryGate } from "./supervisor-online.js";
import { LocalGitError, describeCacheFailure, describeCcFailure, describeLocalGitFailure, fallbackDenyReason,
  formatFailures, invalidResponseFailure, type GateFailure } from "./gate-failure.js";

interface Config {
  catalog: string;
  stateDir: string;
  recoveryRoots: string[];
  recoveryCommands: string[];
}

/** Every hook-side git failure carries its operation, so the denial names it (local_git_failed). */
function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (error) {
    throw new LocalGitError(args.join(" "), error);
  }
}

let auditDir: string | undefined;

function catalogPort(path: string): number {
  const text = readFileSync(path, "utf8");
  const section = text.split(/^  - code: /m).find((part) => /^concordia\s*\r?\n/.test(part));
  const port = Number(section?.match(/^    port: (\d+)\s*$/m)?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Concordia port missing from Excubitor catalog");
  return port;
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

/** TB-WORKAREA の基点。8.3 短縮名と実パスの両方を載せる (どちらの表記で来ても照合できるように)。 */
function workAreaBases(): WorkAreaBases {
  const spellings = (path: string): string[] => {
    const out = [resolve(path)];
    try { out.push(realpathSync(path), realpathSync.native(path)); } catch { /* 無いディレクトリは表記のまま */ }
    return [...new Set(out)];
  };
  const configDirs = [process.env.CLAUDE_CONFIG_DIR, join(homedir(), ".claude")].filter((value): value is string => Boolean(value));
  return { tmpDirs: spellings(tmpdir()), claudeConfigDirs: configDirs.flatMap(spellings) };
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Usage: node supervisor-cli.js <config.json>");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Config;
  if (typeof config.catalog !== "string" || typeof config.stateDir !== "string"
    || ![config.recoveryRoots, config.recoveryCommands].every((values) => Array.isArray(values) && values.every((value) => typeof value === "string"))) {
    throw new Error("Invalid supervisor configuration");
  }
  auditDir = config.stateDir;
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
  if (target && isEditTool(hook.tool_name) && isClaudeWorkArea(target, workAreaBases())) {
    // TB-WORKAREA: git 管理外の Claude 作業領域。照合する checkout が無いので Cc に問わず通し、監査だけ残す。
    mkdirSync(config.stateDir, { recursive: true });
    appendFileSync(join(config.stateDir, "audit.jsonl"), JSON.stringify({ ts: Date.now(), mode: "workarea", decision: "allow",
      project: "", tool: hook.tool_name, rules: [] }) + "\n", "utf8");
    return;
  }
  const probe = target ? dirname(target) : cwd;
  let existingProbe = probe;
  while (!existsSync(existingProbe)) existingProbe = dirname(existingProbe);
  const root = realpathSync(git(existingProbe, ["rev-parse", "--show-toplevel"]));
  const branch = git(root, ["branch", "--show-current"]);
  const commonDir = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const action: HarnessAction = { tool: hook.tool_name, command: hook.tool_input?.command, filePath: target,
    cwd: root, branch, isWorktree: git(root, ["rev-parse", "--git-dir"]) !== git(root, ["rev-parse", "--git-common-dir"]),
    repoCommonRoot: commonRootOf(commonDir) };
  const sessionId = process.env.LICTOR_SESSION_ID ?? "";
  mkdirSync(config.stateDir, { recursive: true });
  let origin: string;
  try { origin = git(root, ["config", "--get-regexp", "^remote\\..*\\.url$"]); }
  catch (error) {
    // git config exits 1 when no remote URL exists; other failures must remain visible.
    if (!(error instanceof LocalGitError) || error.status !== 1) throw error;
    origin = "";
  }
  const cacheKey = createHash("sha256").update(`${root}\n${origin}\n${sessionId}`).digest("hex");
  const cachePath = join(config.stateDir, `${cacheKey}.json`);
  const outcome = await queryGate(port, { action, session_id: sessionId, hook: "supervisor" });
  const response = outcome.kind === "online" ? outcome.response : null;
  let mode = "online";
  let verdict: GateVerdict;
  const failures: GateFailure[] = [];
  if (response && response.status < 500) {
    const body = response.body as (GateVerdict & { local_policy?: unknown }) | null;
    if (response.status !== 200 || !body || !["allow", "warn", "deny"].includes(body.decision)
      || typeof body.blocked !== "boolean" || typeof body.reason !== "string") {
      const failure = invalidResponseFailure(response.status, response.body);
      failures.push(failure);
      verdict = reject(`${formatFailures([failure])}; offline permission was not substituted.`);
    } else {
      verdict = { ...body, blocked: body.blocked || body.decision === "deny" };
      // gate が既知の失敗 (unnamed_branch 等) を理由付き deny で返した場合も種別を監査に残す。
      const code = (body as { error?: unknown }).error;
      if (typeof code === "string" && code) failures.push({ kind: "cc_error", message: code });
      if (usableSnapshot(body.local_policy, action, sessionId, Date.now())) {
        const temporary = `${cachePath}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify(body.local_policy), "utf8");
        renameSync(temporary, cachePath);
      }
    }
  } else {
    const ccFailure = describeCcFailure(outcome);
    if (ccFailure) failures.push(ccFailure);
    let cached: unknown;
    // 破損して読めない場合も「存在した」ことは権限判定に効かせる。 読めないキャッシュを
    // 未取得と同一視すると、 問診など制限の強い session が復旧権限へ格上げされうる。
    const hadCacheFile = existsSync(cachePath);
    if (hadCacheFile) {
      try { cached = JSON.parse(readFileSync(cachePath, "utf8")); }
      catch { process.stderr.write("[harness-supervisor] Invalid cache; recovery-only mode.\n"); }
    }
    const cacheFailure = describeCacheFailure(hadCacheFile, snapshotUnusableReason(cached, action, sessionId, Date.now()));
    if (usableSnapshot(cached, action, sessionId, Date.now())) {
      mode = "cached";
      verdict = evaluateCachedAction(action, cached);
      if (needsDddEvidence(action, cached.policy) && !hasDddEvidence(root, target!)) verdict = reject(DDD_INSTRUCTION);
      if (verdict.blocked && recoveryAllowed(action, config.recoveryRoots.map((path) => realpathSync(path)), config.recoveryCommands)) {
        // Recovery relaxes ONLY the contract prerequisites that a stale/absent Cc cannot
        // re-confirm. Every other cached restriction (inquiry read-only, team worktree,
        // main-push allowlist, strong-model gate) stays authoritative, so we
        // filter the existing verdict rather than re-evaluating against a weaker set.
        const RECOVERABLE = new Set(["contract-incomplete"]);
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
      if (cacheFailure) failures.push(cacheFailure);
      verdict = reject(fallbackDenyReason(failures));
    } else {
      // /health が応答しているのにゲートが上限内に返らない場合は「停止」ではなく「遅延」。
      // 権限は復旧範囲のまま広げず、 再試行で通りうることを区別して伝える。
      mode = outcome.kind === "slow" ? "slow" : "recovery";
      if (cacheFailure) failures.push(cacheFailure);
      verdict = recoveryAllowed(action, config.recoveryRoots.map((path) => realpathSync(path)), config.recoveryCommands)
        ? evaluateAction(action)
        : reject(fallbackDenyReason(failures));
    }
  }
  // No command text, file contents, or prompt payload in the offline audit.
  appendFileSync(join(config.stateDir, "audit.jsonl"), JSON.stringify({ ts: Date.now(), mode, decision: verdict.decision,
    project: cacheKey, tool: action.tool, rules: verdict.hits?.map((hit) => hit.rule) ?? [],
    ...(failures.length ? { failure_kind: failures.map((failure) => failure.kind) } : {}) }) + "\n", "utf8");
  if (mode !== "online") {
    // 原因が拒否文にまだ含まれていない (キャッシュ判定で止めた / 通した) ときだけ前置する。
    const summary = formatFailures(failures);
    const causes = failures.length && !verdict.reason.includes(summary) ? ` ${summary} ->` : "";
    process.stderr.write(`[harness-supervisor] ${mode} mode:${causes} ${verdict.reason}\n`);
  }
  if (verdict.blocked) {
    process.stderr.write(`[harness-supervisor] ${verdict.reason}\n`);
    process.exitCode = 2;
  } else if (verdict.decision === "warn") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: verdict.reason } }));
  }
}

void main().catch((error: unknown) => {
  if (error instanceof LocalGitError) {
    const failure = describeLocalGitFailure(error);
    process.stderr.write(`[harness-supervisor] ${formatFailures([failure])}. The command was not checked against Cc.\n`);
    if (auditDir) {
      try {
        mkdirSync(auditDir, { recursive: true });
        appendFileSync(join(auditDir, "audit.jsonl"), JSON.stringify({ ts: Date.now(), mode: "error", decision: "deny",
          project: "", tool: "", rules: [], failure_kind: [failure.kind] }) + "\n", "utf8");
      } catch { /* an audit write failure must not change the fail-closed exit */ }
    }
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`[harness-supervisor] ${error instanceof Error ? error.message : "Unexpected failure"}\n`);
  process.exitCode = 2;
});
