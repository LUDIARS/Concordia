/**
 * data builder 用の読み取り専用 git 呼び出し。 shell を介さず引数は配列、 cwd はリポ、 時間制限付き。
 * 失敗は null を返す (読めなかった事実は builder が status: unknown として渡す)。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 読み取り adapter
 */

import { execFile } from "node:child_process";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 1024 * 1024;

export type GitRead = (repoPath: string, args: readonly string[]) => Promise<string | null>;

export const gitRead: GitRead = (repoPath, args) => new Promise((resolve) => {
  execFile("git", ["-C", repoPath, ...args], {
    timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, encoding: "utf8",
  }, (error, stdout) => resolve(error ? null : stdout.trim()));
});
