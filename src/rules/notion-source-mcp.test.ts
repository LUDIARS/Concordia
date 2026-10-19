import { describe, expect, it, vi } from "vitest";
import {
  NOTION_MCP_READ_TOOLS,
  buildMcpFetchPrompt,
  createMcpNotionSource,
  describeInvalidOutput,
  MCP_INVALID_ATTEMPTS,
  notionMcpRunOptions,
  parseMcpFetchOutput,
} from "./notion-source-mcp.js";
import { NotionSourceUnavailable } from "./notion-source-types.js";

// 実 claude / 実 Notion は呼ばない。 runner を差し替える。

const ID = "0123456789abcdef0123456789abcdef";
const CHILD = "1123456789abcdef0123456789abcdef";
const LINK = "2123456789abcdef0123456789abcdef";
const limits = { pageTextBytes: 100, maxChildren: 2 };
const ref = { id: ID, url: null };

const ok = (page: Record<string, unknown>) => JSON.stringify({ status: "ok", page });

describe("notionMcpRunOptions", () => {
  it("allows only the Notion read tools", () => {
    const opts = notionMcpRunOptions();
    expect(opts.allowedTools).toEqual(["mcp__claude_ai_Notion__notion-fetch", "mcp__claude_ai_Notion__notion-search"]);
    expect(opts.allowedTools.every((t) => /^mcp__claude_ai_Notion__notion-(fetch|search)$/.test(t))).toBe(true);
    expect(opts.allowedTools.some((t) => /create|update|delete|move|comment|upload/.test(t))).toBe(false);
    expect(NOTION_MCP_READ_TOOLS).toHaveLength(2);
  });

  it("asks for one page only, without writing", () => {
    const prompt = buildMcpFetchPrompt(ref, limits);
    expect(prompt).toContain(ID);
    expect(prompt).toContain("1 回だけ");
    expect(prompt).toContain("書き込み・作成・更新・削除はしない");
    expect(prompt).toContain("unavailable");
    expect(prompt).toContain(`使ってよいツールは ${NOTION_MCP_READ_TOOLS[0]} だけ`);
  });
});

describe("parseMcpFetchOutput", () => {
  it("reads a well-formed page within the limits", () => {
    const out = parseMcpFetchOutput(`前置き ${ok({
      id: ID, title: "例の授業資料", url: "https://www.notion.so/example", last_edited_time: "2026-10-01T00:00:00.000Z",
      text: "あ".repeat(100),
      children: [{ id: CHILD, title: "第1回", url: null }, { id: CHILD, title: "重複" }, { id: LINK, title: "第2回" }, { id: "3123456789abcdef0123456789abcdef" }],
      links: [LINK, ID, "壊れた値"],
    })} 後書き`, ref, limits);
    expect(out.kind).toBe("page");
    if (out.kind !== "page") return;
    expect(out.page).toMatchObject({ id: ID, title: "例の授業資料", via: "mcp", lastEditedMs: Date.parse("2026-10-01T00:00:00.000Z") });
    expect(Buffer.byteLength(out.page.text, "utf8")).toBeLessThanOrEqual(100);
    expect(out.page.children.map((c) => c.id)).toEqual([CHILD, LINK]);
    expect(out.page.links).toEqual([LINK]);
  });

  it("treats wrong shapes as invalid, and reads unavailable / not found", () => {
    expect(parseMcpFetchOutput("not json", ref, limits)).toEqual({ kind: "invalid" });
    expect(parseMcpFetchOutput(JSON.stringify({ status: "ok" }), ref, limits)).toEqual({ kind: "invalid" });
    expect(parseMcpFetchOutput(ok({ id: CHILD, title: "別のページ" }), ref, limits)).toEqual({ kind: "invalid" });
    expect(parseMcpFetchOutput(JSON.stringify({ status: "not_found" }), ref, limits)).toEqual({ kind: "not_found" });
    expect(parseMcpFetchOutput(JSON.stringify({ status: "unavailable", reason: "not authenticated" }), ref, limits))
      .toEqual({ kind: "unavailable", reason: "not authenticated" });
    // 最終更新が無い・壊れていても本文は使う
    const noDate = parseMcpFetchOutput(ok({ id: ID, title: "t", text: "本文", last_edited_time: "昨日" }), ref, limits);
    expect(noDate.kind === "page" && noDate.page.lastEditedMs).toBeNull();
  });
});

describe("createMcpNotionSource", () => {
  it("calls the runner with Notion read tools only, once per page", async () => {
    const runner = vi.fn(async () => ({ ok: true, stdout: ok({ id: ID, title: "t", text: "本文" }), stderr: "" }));
    const page = await createMcpNotionSource({ runner }).fetchPage(ref, limits);
    expect(page?.text).toBe("本文");
    expect(runner).toHaveBeenCalledTimes(1);
    expect((runner.mock.calls[0] as unknown[])[1]).toMatchObject({ allowedTools: [...NOTION_MCP_READ_TOOLS] });
  });

  it("stops as unavailable when the connector is not authenticated", async () => {
    const runner = vi.fn(async () => ({ ok: true, stdout: JSON.stringify({ status: "unavailable", reason: "no Notion connector" }), stderr: "" }));
    await expect(createMcpNotionSource({ runner }).fetchPage(ref, limits)).rejects.toBeInstanceOf(NotionSourceUnavailable);
  });

  it("fails (not unavailable) on an unexpected response, and returns null for a missing page", async () => {
    const bad = vi.fn(async () => ({ ok: false, stdout: "", stderr: "timeout" }));
    const err = await createMcpNotionSource({ runner: bad }).fetchPage(ref, limits).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotionSourceUnavailable);
    const missing = vi.fn(async () => ({ ok: true, stdout: JSON.stringify({ status: "not_found" }), stderr: "" }));
    expect(await createMcpNotionSource({ runner: missing }).fetchPage(ref, limits)).toBeNull();
  });

  it("retries an unreadable response once, then fails with a hint that carries no page text", async () => {
    const flaky = vi.fn()
      .mockResolvedValueOnce({ ok: true, stdout: '{"status": "ok", "page": {"text": "秘密の本文', stderr: "" })
      .mockResolvedValueOnce({ ok: true, stdout: ok({ id: ID, title: "t", text: "本文" }), stderr: "" });
    expect((await createMcpNotionSource({ runner: flaky }).fetchPage(ref, limits))?.text).toBe("本文");
    expect(flaky).toHaveBeenCalledTimes(2);

    const broken = vi.fn(async () => ({ ok: true, stdout: '{"status": "ok", "page": {"text": "秘密の本文"}', stderr: "" }));
    const err = await createMcpNotionSource({ runner: broken }).fetchPage(ref, limits).then(() => new Error("resolved"), (e: unknown) => e as Error);
    expect(broken).toHaveBeenCalledTimes(MCP_INVALID_ATTEMPTS);
    expect(err.message).toContain("JSON does not parse");
    expect(err.message).not.toContain("秘密の本文");
  });

  it("asks again once when the answer is unavailable, and uses the page if the second answer has it", async () => {
    const flaky = vi.fn()
      .mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ status: "unavailable", reason: "tool not available" }), stderr: "" })
      .mockResolvedValueOnce({ ok: true, stdout: ok({ id: ID, title: "t", text: "本文" }), stderr: "" });
    expect((await createMcpNotionSource({ runner: flaky }).fetchPage(ref, limits))?.text).toBe("本文");
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it("retries a timed-out run once", async () => {
    const slow = vi.fn()
      .mockResolvedValueOnce({ ok: false, stdout: "", stderr: "[concordia] killed: timeout" })
      .mockResolvedValueOnce({ ok: true, stdout: ok({ id: ID, title: "t", text: "本文" }), stderr: "" });
    expect((await createMcpNotionSource({ runner: slow }).fetchPage(ref, limits))?.text).toBe("本文");
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it("does not retry a run that failed for another reason", async () => {
    const bad = vi.fn(async () => ({ ok: false, stdout: "", stderr: "spawn claude failed" }));
    await createMcpNotionSource({ runner: bad }).fetchPage(ref, limits).catch(() => null);
    expect(bad).toHaveBeenCalledTimes(1);
  });
});

describe("describeInvalidOutput", () => {
  it("names the shape and length only", () => {
    expect(describeInvalidOutput("  ")).toBe("empty output");
    expect(describeInvalidOutput("ページを読めませんでした")).toBe("12 chars, no JSON object");
    expect(describeInvalidOutput('{"status": "weird"}')).toBe("19 chars, JSON in an unexpected shape");
  });
});
