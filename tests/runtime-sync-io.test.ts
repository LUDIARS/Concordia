// Regression guard for spec/tasks/full-async-io.md: the service's runtime paths
// (requests, interval ticks, event handlers, spawn) must not call blocking fs /
// child_process / zlib APIs. Boot-time, CLI and test-only code may keep them,
// but only in the files listed below, up to the listed count, with a reason.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

const BLOCKING_CALL = new RegExp(
  "\\b(?:existsSync|readFileSync|writeFileSync|appendFileSync|statSync|lstatSync|fstatSync|readdirSync"
  + "|mkdirSync|mkdtempSync|rmSync|rmdirSync|unlinkSync|renameSync|realpathSync|openSync|readSync|writeSync"
  + "|closeSync|chmodSync|copyFileSync|accessSync|truncateSync|utimesSync|symlinkSync|readlinkSync|cpSync"
  + "|execSync|execFileSync|spawnSync"
  + "|deflateRawSync|inflateRawSync|deflateSync|inflateSync|gzipSync|gunzipSync|brotliCompressSync|brotliDecompressSync)"
  + "\\s*\\(",
  "g",
);

/** file (src-relative, forward slashes) → allowed count and why it is not a runtime path. */
const ALLOWED: Record<string, { max: number; reason: string }> = {
  // B: boot-time only
  "bootstrap/core.ts": { max: 2, reason: "loadDotEnv reads .env once at startup" },
  "shared/config.ts": { max: 1, reason: "loadConfig reads the config file once at startup" },
  "shared/secret-box.ts": { max: 5, reason: "secret key create/read once at startup (wx exclusive create)" },
  "db/index.ts": { max: 1, reason: "openDb creates the DB directory once at startup" },
  "control/token.ts": { max: 7, reason: "spawn token file is prepared once while auth initialises" },
  "api/skills.ts": { max: 1, reason: "skill md is read once and memoised in the module" },
  "api/register-web.ts": { max: 2, reason: "web/dist/index.html is read once while routes are registered" },
  "bounty/operator-credentials.ts": { max: 5, reason: "ensureBountyOperatorToken runs once at startup; the per-request read is async" },
  "federation/config-cache.ts": { max: 1, reason: "the offline config cache is read once when the site client starts" },
  "processes/manager.ts": { max: 1, reason: "logs dir is created once when the manager is constructed at startup" },
  "shared/log-file-rotation.ts": { max: 6, reason: "logger rotates its file once at module init, before pino opens it" },
  // C: CLI / separate worker entry points
  "chat-worker.ts": { max: 2, reason: "worker process loadDotEnv at its own startup" },
  "cost-worker.ts": { max: 2, reason: "worker process loadDotEnv at its own startup" },
  "workflow-worker.ts": { max: 2, reason: "worker process loadDotEnv at its own startup" },
  "drop-obsolete-excubitor.ts": { max: 4, reason: "DB migration CLI script" },
  "harness/supervisor-cli.ts": { max: 17, reason: "hook supervisor CLI, a short-lived process per hook" },
  "harness/ddd-evidence.ts": { max: 4, reason: "sync hasDddEvidence is for supervisor-cli; the service uses hasDddEvidenceAsync" },
  "control/inject-source-apply.ts": { max: 2, reason: "inject-source-apply CLI entry point" },
  "developer-tools/migration-preflight/git.ts": { max: 1, reason: "migration-preflight CLI" },
  "developer-tools/migration-preflight/ontime-runtime.ts": { max: 2, reason: "migration-preflight CLI contract evidence" },
  "developer-tools/actio-sync-migration/run.ts": { max: 3, reason: "actio-sync-migration CLI" },
  "developer-tools/actio-sync-migration/legacy-documents.ts": { max: 1, reason: "actio-sync-migration CLI" },
  "developer-tools/actio-sync-migration/legacy-activity.ts": { max: 1, reason: "actio-sync-migration CLI" },
  // D: test-only helpers
  "config/settings/coverage-scan.ts": { max: 3, reason: "static source scan used only by the settings coverage test" },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith(".ts") || /\.(?:test|contract)\.ts$/.test(entry.name)) return [];
    return [path];
  });
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function blockingCalls(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of sourceFiles(SRC)) {
    const count = stripComments(readFileSync(file, "utf8")).match(BLOCKING_CALL)?.length ?? 0;
    if (count > 0) counts.set(relative(SRC, file).replace(/\\/g, "/"), count);
  }
  return counts;
}

describe("runtime paths stay asynchronous (spec/tasks/full-async-io.md)", () => {
  const counts = blockingCalls();

  it("has no blocking fs / child_process / zlib calls outside the boot, CLI and test-only allowlist", () => {
    const violations = [...counts]
      .filter(([file, count]) => count > (ALLOWED[file]?.max ?? 0))
      .map(([file, count]) => `${file}: ${count} blocking call(s), allowed ${ALLOWED[file]?.max ?? 0}`);
    expect(violations).toEqual([]);
  });

  it("keeps the allowlist tight (drop entries once a file no longer needs them)", () => {
    const stale = Object.entries(ALLOWED)
      .filter(([file, entry]) => (counts.get(file) ?? 0) < entry.max)
      .map(([file, entry]) => `${file}: allowed ${entry.max}, found ${counts.get(file) ?? 0}`);
    expect(stale).toEqual([]);
  });

  it("detects a blocking call but ignores one mentioned in a comment", () => {
    const code = "// readFileSync(x)\n/* statSync(y) */\nconst a = existsSync(p);\nconst url = \"http://x\"; execSync(\"ls\");";
    expect(stripComments(code).match(BLOCKING_CALL)?.length).toBe(2);
  });
});
