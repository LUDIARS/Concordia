import { describe, expect, it, vi } from "vitest";
import { importSharedPage, readTabulaConnection, TabulaImportError } from "./tabula-client.js";

const connection = { url: "http://127.0.0.1:5196/", token: "t".repeat(32) };
const input = { key: "concordia-consultation:cp_1", title: "集約の切り方", text: "要点1\n\n要点2", tags: ["技術相談", "技術相談課"] };

describe("importSharedPage", () => {
  it("posts a member-shared page with bearer auth and returns the page", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ note: { id: "page-1", title: "集約の切り方" }, url: "https://tabula/#page=page-1" }), { status: 201 }));
    await expect(importSharedPage(connection, input, fetchImpl)).resolves.toEqual({ pageId: "page-1", url: "https://tabula/#page=page-1" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:5196/api/imports");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${connection.token}`);
    expect(JSON.parse(String(init.body))).toEqual({
      key: "concordia-consultation:cp_1",
      visibility: "shared",
      bundle: {
        note: { title: "集約の切り方", tags: ["技術相談", "技術相談課"] },
        blocks: [{ block_type: "text", text: "要点1" }, { block_type: "text", text: "要点2" }],
      },
    });
  });

  it("reports failures without the response body", async () => {
    const rejected = vi.fn(async () => new Response("secret detail", { status: 401 }));
    await expect(importSharedPage(connection, input, rejected)).rejects.toMatchObject({ code: "rejected", status: 401 });
    await expect(importSharedPage(connection, input, rejected)).rejects.not.toThrow(/secret detail/);
    const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    await expect(importSharedPage(connection, input, down)).rejects.toBeInstanceOf(TabulaImportError);
    const odd = vi.fn(async () => new Response("{}", { status: 201 }));
    await expect(importSharedPage(connection, input, odd)).rejects.toMatchObject({ code: "malformed_response" });
  });
});

describe("readTabulaConnection", () => {
  it("needs both the url and the token", () => {
    expect(readTabulaConnection({ url: " http://t ", token: "abc" })).toEqual({ url: "http://t", token: "abc" });
    expect(readTabulaConnection({ url: null, token: "abc" })).toBeNull();
    expect(readTabulaConnection({ url: "http://t", token: " " })).toBeNull();
  });
});
