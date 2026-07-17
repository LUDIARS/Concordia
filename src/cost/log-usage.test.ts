import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findClaudeLog, CLAUDE_PROJECTS_ROOT } from "./log-usage.js";
import type { SessionRow } from "../shared/types.js";

// CLAUDE_PROJECTS_ROOT は ~/.claude/projects 固定なので、 そこに一時プロジェクトフォルダを
// 掘って exact-match (<id>.jsonl) で発見できることを検証する。
// 後始末は「このテストが作ったものだけ」を消す:
//  - ディレクトリが実在した (= 実ユーザの transcript/memory ディレクトリ) 場合は
//    ディレクトリを削除せず、 書いた fake jsonl だけを消す。
//  - recursive rm は「このテストが新規作成したディレクトリ」限定。
const madeDirs: string[] = [];
const madeFiles: string[] = [];
afterEach(() => {
  for (const f of madeFiles.splice(0)) rmSync(f, { force: true });
  for (const d of madeDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sess(id: string, repo_path: string): SessionRow {
  return {
    id, provider: "claude-code", repo_path, repo_origin: null, branch: null, host: "h",
    started_at: 0, ended_at: null, status: "active", last_seen_at: 0,
    current_task: null, transcript_path: null, metadata: null, ws_clients: 0, target_project: null,
  };
}

describe("findClaudeLog encoding", () => {
  it("Windows ドライブパスを Claude Code と同じ <encoded> に変換して発見する (隣接特殊文字を潰さない)", async () => {
    // E:/Document/Ars → E--Document-Ars (`:/` が `--`、 collapse しない)。
    const dir = join(CLAUDE_PROJECTS_ROOT, "E--Document-Ars");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      madeDirs.push(dir);
    }
    const id = "11111111-2222-3333-4444-555555555555";
    const p = join(dir, `${id}.jsonl`);
    writeFileSync(p, JSON.stringify({ message: { usage: { input_tokens: 1 } } }), "utf8");
    madeFiles.push(p);
    expect(await findClaudeLog(sess(id, "E:/Document/Ars"))).toBe(p);
    // バックスラッシュ表記でも同じ encoded に落ちる。
    expect(await findClaudeLog(sess(id, "E:\\Document\\Ars"))).toBe(p);
  });
});
