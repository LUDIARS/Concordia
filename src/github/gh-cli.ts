/**
 * GitHub への読み書きを `gh` CLI 1 本に閉じる (src/pr/reconcile.ts と同じ経路)。
 *
 * Cc は GitHub トークンを持たない・保存しない。 資格情報は `gh` の認証が正本で、
 * ここはコマンド組み立てと出力の解釈だけを持つ。 日本語の本文は引数に直書きすると
 * シェル経由で化けるため、 必ず一時ファイル (`--body-file`) 経由で渡す。
 *
 * @implements spec/feature/github-issue-workflow.md — 契約
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GH_BIN = process.platform === "win32" ? "gh.exe" : "gh";
const DEFAULT_TIMEOUT_MS = 20_000;

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  /** 起票者。 承認の妥当性チェックでラベル付与者と併せて見る。 */
  author: string;
}

/** テストが差し替える最小の実行面。 */
export interface GhRunner {
  run(args: readonly string[], options?: { timeoutMs?: number }): Promise<string>;
}

export const ghCliRunner: GhRunner = {
  async run(args, options) {
    const { stdout } = await execFileAsync(GH_BIN, [...args], {
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  },
};

/** 本文を UTF-8 の一時ファイルへ書いて渡し、 成否に関わらず消す。 */
async function withBodyFile<T>(body: string, use: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "cc-github-"));
  const path = join(dir, "body.md");
  try {
    await writeFile(path, body, "utf8");
    return await use(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface GithubGateway {
  listLabeledIssues(repoOrigin: string, label: string, limit?: number): Promise<GhIssue[]>;
  /** Issue の event 履歴から、指定ラベルを最後に付けた GitHub login を返す。 */
  findLabelActor(repoOrigin: string, issueNumber: number, label: string): Promise<string | null>;
  commentOnIssue(repoOrigin: string, issueNumber: number, body: string): Promise<void>;
  createPullRequest(input: {
    repoOrigin: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<string>;
  /** 既に同じ head の PR があればその URL。 無ければ null。 */
  findPullRequestByHead(repoOrigin: string, head: string): Promise<string | null>;
}

export function createGithubGateway(runner: GhRunner = ghCliRunner): GithubGateway {
  return {
    async listLabeledIssues(repoOrigin, label, limit = 50) {
      const stdout = await runner.run([
        "issue", "list",
        "--repo", repoOrigin,
        "--label", label,
        "--state", "open",
        "--limit", String(Math.min(Math.max(limit, 1), 200)),
        "--json", "number,title,body,url,labels,author",
      ]);
      const parsed = JSON.parse(stdout) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((entry): GhIssue[] => {
        const row = entry as Record<string, unknown>;
        if (typeof row.number !== "number") return [];
        const labels = Array.isArray(row.labels)
          ? row.labels.flatMap((item) => {
            const name = (item as Record<string, unknown> | null)?.name;
            return typeof name === "string" ? [name] : [];
          })
          : [];
        return [{
          number: row.number,
          title: typeof row.title === "string" ? row.title : "",
          body: typeof row.body === "string" ? row.body : "",
          url: typeof row.url === "string" ? row.url : "",
          labels,
          author: typeof (row.author as Record<string, unknown> | null)?.login === "string"
            ? (row.author as { login: string }).login
            : "",
        }];
      });
    },

    async findLabelActor(repoOrigin, issueNumber, label) {
      const stdout = await runner.run([
        "api",
        "--method", "GET",
        "--paginate",
        "--slurp",
        `repos/${repoOrigin}/issues/${issueNumber}/events`,
        "-f", "per_page=100",
      ]);
      const parsed = JSON.parse(stdout) as unknown;
      if (!Array.isArray(parsed)) return null;
      const events = parsed.flatMap((page) => Array.isArray(page) ? page : [page]);
      for (const entry of events.reverse()) {
        if (!entry || typeof entry !== "object") continue;
        const row = entry as Record<string, unknown>;
        if (row.event !== "labeled") continue;
        const attached = (row.label as Record<string, unknown> | null)?.name;
        if (typeof attached !== "string" || attached.trim().toLowerCase() !== label.trim().toLowerCase()) continue;
        const actor = (row.actor as Record<string, unknown> | null)?.login;
        return typeof actor === "string" && actor.trim() !== "" ? actor : null;
      }
      return null;
    },

    async commentOnIssue(repoOrigin, issueNumber, body) {
      await withBodyFile(body, async (path) => {
        await runner.run([
          "issue", "comment", String(issueNumber),
          "--repo", repoOrigin,
          "--body-file", path,
        ]);
      });
    },

    async createPullRequest(input) {
      const stdout = await withBodyFile(input.body, (path) => runner.run([
        "pr", "create",
        "--repo", input.repoOrigin,
        "--head", input.head,
        "--base", input.base,
        "--title", input.title,
        "--body-file", path,
      ], { timeoutMs: 60_000 }));
      const url = stdout.trim().split(/\s+/).find((token) => token.startsWith("https://"));
      // stdout は CLI/remote の任意文面を含み得るため、例外や run 台帳へ転載しない。
      if (!url) throw new Error("gh pr create did not return a URL");
      return url;
    },

    async findPullRequestByHead(repoOrigin, head) {
      const stdout = await runner.run([
        "pr", "list",
        "--repo", repoOrigin,
        "--head", head,
        "--state", "all",
        "--limit", "1",
        "--json", "url",
      ]);
      const parsed = JSON.parse(stdout) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      const url = (parsed[0] as Record<string, unknown>).url;
      return typeof url === "string" ? url : null;
    },
  };
}
