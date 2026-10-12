// Actio と Cc のずれを解消する移行手順 M1〜M6 (spec/faq/actio-cc-task-project-sync.md §5)。
// 既定は dry-run: 計画を JSON に書き出すだけで何も更新しない。
//   node --import tsx tools/actio-sync-migration.mjs --actio-url <url> --cc-url <url> [--db <path>] [--out <file>] [--rename OLD=NEW]
//   M5 (旧 md タスク) は直近 --legacy-recent-days <日数> (既定 30) の pending / delegated だけを作り、残りは archive する。
// 人が計画を確認した後だけ: --apply M1,M2,M3,M4,M5 --plan <dry-run の出力> --out <結果ファイル>
import { join } from "node:path";
import { parseSyncMigrationArgs } from "../src/developer-tools/actio-sync-migration/args.ts";
import { createLegacyMigrationIo } from "../src/developer-tools/actio-sync-migration/legacy-io.ts";
import { runApply, runDryRun } from "../src/developer-tools/actio-sync-migration/run.ts";

async function request(method, url, body) {
  const response = await fetch(url, {
    method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}`);
  return response.json();
}

const http = { get: (url) => request("GET", url), patch: (url, body) => request("PATCH", url, body) };
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

try {
  const args = parseSyncMigrationArgs(process.argv.slice(2), process.env, {
    dbPath: join(process.cwd(), "concordia.db"), out: join(process.cwd(), `actio-sync-migration-${stamp}.json`),
  });
  const legacy = createLegacyMigrationIo(args.actioUrl, process.env);
  if (args.apply) {
    const result = await runApply(args, http, legacy);
    process.stdout.write(`applied=${result.applied} skipped=${result.skipped} failed=${result.failed}\nresults: ${args.out}\n`);
    if (result.failed > 0) process.exitCode = 1;
  } else {
    const plan = await runDryRun(args, http, new Date(), legacy);
    process.stdout.write(`${JSON.stringify(plan.summary, null, 2)}\nplan (dry-run): ${args.out}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
