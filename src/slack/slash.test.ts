import { describe, it, expect, vi, afterEach } from "vitest";
import { parseSlashCommand } from "./render.js";
import { formatStat, formatHelp, runSlackSlash, spawnSession, subFromCoCommand } from "./slash.js";

describe("runSlackSlash 早期バリデーション (ネットワーク前)", () => {
  const deps = { concordiaUrl: "http://127.0.0.1:1" };
  it("spawn の不正 provider は fetch せずエラーメッセージ", async () => {
    const out = await runSlackSlash(deps, "spawn nope");
    expect(out).toContain("provider は");
  });
  it("end の短すぎる prefix は fetch せず案内", async () => {
    const out = await runSlackSlash(deps, "end ab");
    expect(out).toContain("先頭 4 桁以上");
  });
  it("help はヘルプを返す", async () => {
    expect(await runSlackSlash(deps, "")).toContain("/concordia stat");
    expect(await runSlackSlash(deps, "help")).toContain("/concordia spawn");
  });
});

describe("spawnSession (構造化入力 — slash と custom function 共通)", () => {
  afterEach(() => vi.restoreAllMocks());
  const deps = { concordiaUrl: "http://127.0.0.1:1" };

  it("不正 provider は fetch せずエラーメッセージ", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    const out = await spawnSession(deps, "nope");
    expect(out).toContain("provider は");
    expect(f).not.toHaveBeenCalled();
  });

  it("provider 未指定は claude 既定で POST し、 cwd を body に載せる", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ pid: 4242 }), { status: 200 }),
    );
    const out = await spawnSession(deps, undefined, "E:/Document/Ars/Cernere");
    expect(out).toContain("✅ spawn 起動");
    expect(out).toContain("4242");
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ provider: "claude", cwd: "E:/Document/Ars/Cernere" });
  });

  it("空 cwd は body に載せない", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ pid: 1 }), { status: 200 }),
    );
    await spawnSession(deps, "codex", "  ");
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ provider: "codex" });
  });
});

describe("subFromCoCommand", () => {
  it("/co-<sub> から sub を取り出す", () => {
    expect(subFromCoCommand("/co-stat")).toBe("stat");
    expect(subFromCoCommand("/co-prs")).toBe("prs");
    expect(subFromCoCommand("/co-spawn")).toBe("spawn");
    expect(subFromCoCommand("/co-STAT")).toBe("stat"); // sub は小文字化
  });
  it("/co- 始まりでなければ null", () => {
    expect(subFromCoCommand("/concordia")).toBeNull();
    expect(subFromCoCommand("/cospawn")).toBeNull();
    expect(subFromCoCommand("")).toBeNull();
    expect(subFromCoCommand(undefined)).toBeNull();
    expect(subFromCoCommand("/co-")).toBeNull();
  });
});

describe("parseSlashCommand", () => {
  it("空は help", () => {
    expect(parseSlashCommand("")).toEqual({ sub: "help", args: "" });
    expect(parseSlashCommand("   ")).toEqual({ sub: "help", args: "" });
  });
  it("単語のみ", () => {
    expect(parseSlashCommand("stat")).toEqual({ sub: "stat", args: "" });
    expect(parseSlashCommand("PRS")).toEqual({ sub: "prs", args: "" });
  });
  it("sub + args", () => {
    expect(parseSlashCommand("spawn claude E:/x")).toEqual({ sub: "spawn", args: "claude E:/x" });
  });
});

describe("formatStat", () => {
  it("空はメッセージ", () => {
    expect(formatStat([])).toContain("ありません");
  });
  it("session_id 8桁 + status + task を行にする", () => {
    const out = formatStat([
      { session_id: "abcdefgh1234", session: { status: "active", current_task: "やること" } },
      { session_id: "zzzz", session: { status: "lost", current_task: null, branch: "feat/x" } },
    ]);
    expect(out).toContain("abcdefgh");
    expect(out).toContain("active");
    expect(out).toContain("やること");
    expect(out).toContain("feat/x"); // task 無し → branch fallback
  });
});

describe("formatHelp", () => {
  it("stat / prs を案内", () => {
    const h = formatHelp();
    expect(h).toContain("/concordia stat");
    expect(h).toContain("/concordia prs");
  });
});
