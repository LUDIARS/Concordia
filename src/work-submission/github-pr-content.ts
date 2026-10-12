// GitHub PR の題と本文をブランチのコミットから組み立てる。LLM は挟まない。
// 公開リポに出るため、本文はローカルパス・秘密を伏せる (github/text.ts と同じ規則)。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeGithubPublicText } from "../github/text.js";

const execFileAsync = promisify(execFile);

export type GitRead = (repoPath: string, args: readonly string[]) => Promise<string>;

const gitRead: GitRead = async (repoPath, args) => (await execFileAsync("git", ["-C", repoPath, ...args], {
  encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 1_048_576,
})).stdout;

/** `base..HEAD` のコミット件名 (新しい順) から題と本文を作る。コミットが無ければ null。 */
export function composeGithubPr(subjects: readonly string[]): { title: string; body: string } | null {
  const lines = subjects.map((subject) => subject.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  // 最初のコミットがブランチの主題。 後続は修正であることが多い。
  const title = sanitizeGithubPublicText(lines[lines.length - 1]);
  const body = [
    "## Commits",
    ...lines.slice().reverse().map((subject) => `- ${sanitizeGithubPublicText(subject)}`),
    "",
    "Submitted through Concordia (`POST /v1/implementation-tools/submit`).",
  ].join("\n");
  return { title, body };
}

/** ブランチのコミットを読み、PR の題と本文を返す。 base に対して進んでいなければ null。 */
export async function readGithubPrContent(repoPath: string, base: string, read: GitRead = gitRead): Promise<{ title: string; body: string } | null> {
  const output = await read(repoPath, ["log", "--format=%s", `${base}..HEAD`]);
  return composeGithubPr(output.split(/\r?\n/));
}
