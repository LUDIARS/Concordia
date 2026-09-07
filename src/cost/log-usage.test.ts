import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLAUDE_PROJECTS_ROOT, resolveSessionTranscript, resolveTrustedTranscriptPath } from "./log-usage.js";
import type { SessionRow } from "../shared/types.js";

// CLAUDE_PROJECTS_ROOT は ~/.claude/projects 固定なので、 そこに一時プロジェクトフォルダを
// 掘って、 報告された transcript が正本ルート配下と判定されることを検証する。
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

// セッション ↔ transcript の対応は Lictor が報告した権威パスだけで決める。
// 以前は repo_path から引いたディレクトリで「開始時刻がいちばん近い JSONL」を選ぶ
// 独自ロジックを持っており、排他が無いので複数セッションが同じファイルを掴んでいた
// (2026-09-07 実測: 直近 5 日の claude-code 148 本中 18 本が誤り、うち 2 組は
// 秒差起動で同一ファイルを共有)。フォールバックは持たない。
describe("resolveSessionTranscript", () => {
  it("報告された権威 transcript だけを返す", async () => {
    const dir = join(CLAUDE_PROJECTS_ROOT, "E--Document-Ars");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      madeDirs.push(dir);
    }
    const id = "11111111-2222-3333-4444-555555555555";
    const p = join(dir, `${id}.jsonl`);
    writeFileSync(p, JSON.stringify({ message: { usage: { input_tokens: 1 } } }), "utf8");
    madeFiles.push(p);

    const reported = sess(id, "E:/Document/Ars");
    reported.transcript_path = p;
    expect(await resolveSessionTranscript(reported)).toBe(p);
  });

  it("報告が無ければ推測せず null を返す", async () => {
    // 同じディレクトリに実ファイルがあっても、報告が無い限り掴まない。
    // 「他人のログで埋め合わせる」ことが取り違えの原因だった。
    const dir = join(CLAUDE_PROJECTS_ROOT, "E--Document-Ars");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      madeDirs.push(dir);
    }
    const id = "22222222-2222-3333-4444-555555555555";
    const p = join(dir, `${id}.jsonl`);
    writeFileSync(p, JSON.stringify({ message: { usage: { input_tokens: 1 } } }), "utf8");
    madeFiles.push(p);

    expect(await resolveSessionTranscript(sess(id, "E:/Document/Ars"))).toBeNull();
  });

  it("provider 正本ツリーの外を指す報告は受け付けない", async () => {
    const outside = join(tmpdir(), `outside-transcript-${Date.now()}.jsonl`);
    writeFileSync(outside, "{}"+String.fromCharCode(10), "utf8");
    madeFiles.push(outside);
    const s = sess("33333333-2222-3333-4444-555555555555", "E:/Document/Ars");
    s.transcript_path = outside;
    expect(await resolveSessionTranscript(s)).toBeNull();
  });

  it("codex-sdk など JSONL を持たない provider は null", async () => {
    const s = sess("44444444-2222-3333-4444-555555555555", "E:/Document/Ars");
    s.provider = "codex-sdk";
    s.transcript_path = null;
    expect(await resolveSessionTranscript(s)).toBeNull();
  });
});

describe("resolveTrustedTranscriptPath", () => {
  it("accepts only an existing JSONL below the provider transcript root", async () => {
    const nonce = `${Date.now()}-${Math.random()}`;
    const root = join(tmpdir(), `trusted-transcript-${nonce}`);
    const transcript = join(root, "nested", "session.jsonl");
    const outside = join(tmpdir(), `untrusted-transcript-${nonce}.jsonl`);
    try {
      mkdirSync(join(root, "nested"), { recursive: true });
      writeFileSync(transcript, "{}\n", "utf8");
      writeFileSync(outside, "{}\n", "utf8");
      await expect(resolveTrustedTranscriptPath(transcript, root)).resolves.toBeTruthy();
      await expect(resolveTrustedTranscriptPath(outside, root)).resolves.toBeNull();
      await expect(resolveTrustedTranscriptPath(join(root, "not-jsonl.txt"), root)).resolves.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });
});
