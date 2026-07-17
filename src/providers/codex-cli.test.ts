import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MISS_CACHE_TTL_MS,
  findCodexTranscript,
  resetCodexTranscriptCache,
} from "./codex-cli.js";

const SESSION_ID = "0198a2b4-0000-7000-8000-000000000001";

function sessionMetaLine(id: string): string {
  return JSON.stringify({ type: "session_meta", payload: { id } });
}

describe("findCodexTranscript", () => {
  let root: string;

  beforeEach(() => {
    resetCodexTranscriptCache();
    root = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeRollout(day: string, name: string, firstLine: string, padBytes = 0): string {
    const dir = join(root, "2026", "07", day);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    const pad = padBytes > 0 ? `\n${JSON.stringify({ type: "event", payload: { blob: "x".repeat(padBytes) } })}` : "";
    writeFileSync(path, `${firstLine}${pad}\n`, "utf8");
    return path;
  }

  it("先頭行の session id で transcript を見つける", async () => {
    const expected = writeRollout("15", "rollout-2026-07-15T10-00-00-a.jsonl", sessionMetaLine(SESSION_ID));
    expect(await findCodexTranscript(SESSION_ID, { root })).toBe(expected);
  });

  it("巨大ファイルでも先頭チャンクだけで判定できる (全量読みしない)", async () => {
    // 先頭 64KB を大きく超える 2MB 級の行を持つファイルが混ざっていても、
    // 判定は先頭行で済む。
    writeRollout("14", "rollout-2026-07-14T09-00-00-b.jsonl", sessionMetaLine("other-id"), 2 * 1024 * 1024);
    const expected = writeRollout("15", "rollout-2026-07-15T10-00-00-a.jsonl", sessionMetaLine(SESSION_ID), 2 * 1024 * 1024);
    const started = Date.now();
    expect(await findCodexTranscript(SESSION_ID, { root })).toBe(expected);
    // 全量読みなら 4MB 超読む。 head 読みならミリ秒オーダーで終わる (回帰検知の緩い上限)。
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("新しい日付ディレクトリを先に探す", async () => {
    // 同じ session id を新旧 2 箇所に置いたら新しい方が返る = 降順走査の検証。
    writeRollout("01", "rollout-2026-07-01T00-00-00-old.jsonl", sessionMetaLine(SESSION_ID));
    const newest = writeRollout("15", "rollout-2026-07-15T23-59-59-new.jsonl", sessionMetaLine(SESSION_ID));
    expect(await findCodexTranscript(SESSION_ID, { root })).toBe(newest);
  });

  it("発見済み path はキャッシュされ、 次回はスキャンしない", async () => {
    const expected = writeRollout("15", "rollout-2026-07-15T10-00-00-a.jsonl", sessionMetaLine(SESSION_ID));
    expect(await findCodexTranscript(SESSION_ID, { root })).toBe(expected);
    // root を存在しないパスに差し替えてもキャッシュ済みなら返る。
    expect(await findCodexTranscript(SESSION_ID, { root: join(root, "does-not-exist") })).toBe(expected);
  });

  it("見つからない sessionId は TTL 内は再スキャンしない (負キャッシュ)", async () => {
    let clock = 1_000_000;
    const now = (): number => clock;
    expect(await findCodexTranscript(SESSION_ID, { root, now })).toBeNull();
    // TTL 内: 後からファイルが現れても null のまま (再スキャン抑止の検証)。
    const path = writeRollout("15", "rollout-2026-07-15T10-00-00-a.jsonl", sessionMetaLine(SESSION_ID));
    expect(await findCodexTranscript(SESSION_ID, { root, now })).toBeNull();
    // TTL 経過後は再スキャンして見つかる。
    clock += MISS_CACHE_TTL_MS + 1;
    expect(await findCodexTranscript(SESSION_ID, { root, now })).toBe(path);
  });

  it("root が無ければ null", async () => {
    expect(await findCodexTranscript(SESSION_ID, { root: join(root, "missing") })).toBeNull();
  });

  it("負キャッシュは miss を重ねるたび TTL が倍増する (指数バックオフ)", async () => {
    let clock = 1_000_000;
    const now = (): number => clock;
    // miss #1 → TTL 60s
    expect(await findCodexTranscript(SESSION_ID, { root, now })).toBeNull();
    // 60s+ 経過 → 再スキャン (miss #2) → TTL 120s に倍増
    clock += MISS_CACHE_TTL_MS + 1;
    expect(await findCodexTranscript(SESSION_ID, { root, now })).toBeNull();
    // ここでファイルが現れる。 だが 60s 後はまだ 120s TTL 内 → null のまま。
    const path = writeRollout("15", "rollout-2026-07-15T10-00-00-a.jsonl", sessionMetaLine(SESSION_ID));
    clock += MISS_CACHE_TTL_MS + 1;
    expect(await findCodexTranscript(SESSION_ID, { root, now })).toBeNull();
    // 倍増 TTL (120s) を超えたら再スキャンして見つかる。
    clock += MISS_CACHE_TTL_MS + 1;
    expect(await findCodexTranscript(SESSION_ID, { root, now })).toBe(path);
  });
});
