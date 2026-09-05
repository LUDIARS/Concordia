/**
 * 作業ブランチの GitHub 送出。
 *
 * 素の `git push` は Revisor の push guard に落ちる (それが正しい — 送出の認可は
 * Revisor が持つ)。 Cc は `revisor push` を呼ぶだけで、 認可の判断はしない。
 * CLI の在り処は Excubitor catalog の cwd が正本 (ハードコードしない — port-source-rule)。
 *
 * @implements spec/feature/github-issue-workflow.md — パイプライン
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExcubitorClient } from "../excubitor/client.js";

const execFileAsync = promisify(execFile);

const REVISOR_SERVICE_CODE = "revisor";

export interface BranchPusher {
  push(input: { repoPath: string; branch: string; actor: string }): Promise<void>;
}

export function createRevisorBranchPusher(deps: {
  excubitor: Pick<ExcubitorClient, "findService">;
  exec?: (file: string, args: readonly string[], cwd: string) => Promise<void>;
}): BranchPusher {
  const exec = deps.exec ?? (async (file, args, cwd) => {
    await execFileAsync(file, [...args], {
      cwd,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
  });

  return {
    async push({ repoPath, branch, actor }) {
      const service = await deps.excubitor.findService(REVISOR_SERVICE_CODE);
      const revisorCwd = service?.catalog_snapshot?.cwd ?? null;
      if (!revisorCwd) {
        // 場所が分からないまま git を直接叩くと push guard に落ちるだけなので、
        // 「送れない」と明示して止める (黙って別経路へ逃げない)。
        throw new Error("Revisor CLI が見つからない (Excubitor catalog に revisor の cwd が無い)");
      }
      // 稼働中 Concordia と同じ Node 実体を使い、PATH 上の別 node を拾わない。
      await exec(process.execPath, [
        join(revisorCwd, "src", "cli.mjs"),
        "push",
        "--repo", repoPath,
        "--branch", branch,
        "--actor", actor,
      ], repoPath);
    },
  };
}
