import { execFile } from "node:child_process";
import { resolveAugurCliPath } from "../delegation/augur-acceptance.js";
import { unavailable, ToolUnavailable } from "./contracts.js";

export interface CliResult { code: number | null; stdout: string }
export type ToolCliRunner = (cli: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<CliResult>;
export const runToolCli: ToolCliRunner = (cli, args, cwd, signal) => new Promise((resolve, reject) => {
  execFile(process.execPath, [cli, ...args], { cwd, windowsHide: true, shell: false,
    timeout: 10 * 60_000, signal, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
    if (error && (typeof error.code !== "number" || error.killed)) {
      reject(new ToolUnavailable("test_execution_outcome_unknown", "Augur の run 記録で同じ repo・head・bundle の結果を確認してください。新しい依頼で再実行しないでください。")); return;
    }
    resolve({ code: error && typeof error.code === "number" ? error.code : 0, stdout });
  });
});

export class AugurTools {
  private readonly controller = new AbortController();
  constructor(private readonly roots: () => string[], private readonly runner: ToolCliRunner = runToolCli) {}
  close(): void { this.controller.abort(); }
  cli(): string {
    const path = resolveAugurCliPath({ workspaceRoots: this.roots(), env: process.env });
    if (!path) unavailable("augur_not_installed", "workspace に Augur CLI を準備し、対象 repo のテストを登録してください。HTTP daemon は不要です。");
    return path;
  }
  async list(cwd: string): Promise<unknown> {
    const result = await this.runner(this.cli(), ["tests", "list", "--repo", cwd, "--json"], cwd, this.controller.signal);
    if (result.code !== 0) unavailable("augur_catalog_failed", "Augur のテスト登録と CLI を確認してください。");
    const data: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(data)) throw new Error("invalid Augur catalog");
    return data;
  }
  async run(cwd: string, bundle: string, head: string): Promise<unknown> {
    const result = await this.runner(this.cli(), ["tests", "run", "--repo", cwd, "--bundle", bundle,
      "--head", head, "--no-promote", "--json"], cwd, this.controller.signal);
    const data: unknown = JSON.parse(result.stdout);
    if (!data || typeof data !== "object") throw new Error("invalid Augur result");
    if ("empty" in data && data.empty === true) unavailable("test_bundle_empty", "Augur に対象テストを登録し、bundle を確認してください。空の実行は合格ではありません。");
    const passed = result.code === 0 && "status" in data && data.status === "passed";
    return { passed, exit_code: result.code, run: data };
  }
}
