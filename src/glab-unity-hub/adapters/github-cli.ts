/**
 * GitHub への起票・PR コメント・差分取得 (IssuePort の gh CLI 実装)。
 *
 * Concordia は GitHub トークンを持たない。 資格情報は `gh` の認証が正本で、 既存の
 * src/github/gh-cli.ts と同じ実行面 (GhRunner) を使う。 本文は一時ファイル経由で渡す
 * (日本語をコマンドライン引数に直書きしない)。 Unity にはトークンを持たせない。
 *
 * @implements spec/feature/glab-unity-hub.md §4a / §4d (GUH-GITHUB)
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghCliRunner, type GhRunner } from "../../github/gh-cli.js";
import { HubError } from "../domain/protocol.js";
import type { IssuePort } from "../application/ports.js";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_DIFF_CHARS = 400_000;

async function withBodyFile<T>(body: string, use: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "cc-glab-unity-"));
  const path = join(dir, "body.md");
  try {
    await writeFile(path, body, "utf8");
    return await use(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function requireRepo(repo: string): void {
  if (!REPO_RE.test(repo)) throw new HubError("invalid_request", "repo must be owner/name");
}

export class GhCliIssues implements IssuePort {
  constructor(private readonly runner: GhRunner = ghCliRunner) {}

  async createIssue(input: { repo: string; title: string; body: string; labels: string[] }): Promise<string> {
    requireRepo(input.repo);
    return withBodyFile(input.body, async (path) => {
      const args = ["issue", "create", "--repo", input.repo, "--title", input.title, "--body-file", path];
      for (const label of input.labels) args.push("--label", label);
      let stdout: string;
      try {
        stdout = await this.runner.run(args, { timeoutMs: 30_000 });
      } catch {
        if (input.labels.length === 0) throw new HubError("upstream_unavailable", "GitHub issue creation failed");
        // 存在しないラベルで落ちることがある。 ラベル無しでもう一度だけ起票する。
        stdout = await this.runner.run(args.slice(0, 8), { timeoutMs: 30_000 })
          .catch(() => { throw new HubError("upstream_unavailable", "GitHub issue creation failed"); });
      }
      const url = stdout.trim().split(/\s+/).find((part) => part.startsWith("https://github.com/"));
      if (!url) throw new HubError("upstream_unavailable", "gh did not return the issue URL");
      return url;
    });
  }

  async commentOnPullRequest(repo: string, number: number, body: string): Promise<void> {
    requireRepo(repo);
    await withBodyFile(body, async (path) => {
      await this.runner.run(["pr", "comment", String(number), "--repo", repo, "--body-file", path], { timeoutMs: 30_000 });
    });
  }

  async pullRequestDiff(repo: string, number: number): Promise<string> {
    requireRepo(repo);
    const diff = await this.runner.run(["pr", "diff", String(number), "--repo", repo], { timeoutMs: 60_000 });
    return diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) : diff;
  }
}
