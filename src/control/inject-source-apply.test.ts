import { describe, expect, it } from "vitest";
import { runInjectSourceCli, type CliIo } from "./inject-source-apply.js";
import { resolveConcordiaUrl, type FetchLike } from "./inject-source-client.js";

interface Call { method: string; url: string; body?: unknown }

function fakeIo(responses: Array<{ status: number; body: unknown }>, files: Record<string, string> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const fetch: FetchLike = async (url, init) => {
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(init.body) : undefined });
    const next = responses.shift() ?? { status: 500, body: {} };
    return { status: next.status, json: async () => next.body };
  };
  const io: CliIo = {
    env: { CONCORDIA_URL: "http://cc.test/" },
    fetch,
    readFile: (path) => files[path] ?? "",
    writeFile: (path, content) => { written[path] = content; },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { io, calls, out, err, written };
}

const source = { id: "session.work_policy", content: "旧本文", revision: "a".repeat(64), history_version_id: 7, apply_scope: "next_startup_policy" };

describe("inject-source-apply", () => {
  it("接続先は env からだけ決め、無ければ失敗する", () => {
    expect(resolveConcordiaUrl({ CONCORDIA_URL: "http://x/" })).toBe("http://x");
    expect(resolveConcordiaUrl({ CONCORDIA_HOST: "h", CONCORDIA_PORT: "123" })).toBe("http://h:123");
    expect(() => resolveConcordiaUrl({})).toThrow(/CONCORDIA_URL/);
  });

  it("get は本文を出力し revision を標準エラーに出す", async () => {
    const t = fakeIo([{ status: 200, body: { source } }]);
    expect(await runInjectSourceCli(["get", source.id], t.io)).toBe(0);
    expect(t.out).toEqual(["旧本文"]);
    expect(t.err[0]).toContain(`revision=${source.revision}`);
    expect(t.calls[0]!.url).toBe("http://cc.test/v1/admin/inject-sources/session.work_policy");
  });

  it("apply は履歴 GET → 本文 GET → 版付き PUT の順で書く", async () => {
    const t = fakeIo([
      { status: 200, body: { versions: [], next_before: null, pending: null } },
      { status: 200, body: { source } },
      { status: 200, body: { source: { ...source, content: "新本文", revision: "b".repeat(64), history_version_id: 8 } } },
    ], { "new.md": "新本文" });
    const code = await runInjectSourceCli(["apply", source.id, "--file", "new.md", "--expected-revision", source.revision], t.io);
    expect(code).toBe(0);
    expect(t.calls.map((c) => c.method)).toEqual(["GET", "GET", "PUT"]);
    expect(t.calls[0]!.url).toContain("/history?limit=1");
    expect(t.calls[2]!.body).toEqual({ content: "新本文", expected_revision: source.revision, expected_version_id: 7 });
    expect(t.err[0]).toContain("version=8");
  });

  it("読んだ revision が古ければ PUT を送らない", async () => {
    const t = fakeIo([
      { status: 200, body: { versions: [] } },
      { status: 200, body: { source } },
    ], { "new.md": "新本文" });
    const code = await runInjectSourceCli(["apply", source.id, "--file", "new.md", "--expected-revision", "c".repeat(64)], t.io);
    expect(code).toBe(1);
    expect(t.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("409 は現在の revision を示して失敗し、再送しない", async () => {
    const t = fakeIo([
      { status: 200, body: { versions: [] } },
      { status: 200, body: { source } },
      { status: 409, body: { error: "revision_conflict", source: { revision: "d".repeat(64) } } },
    ], { "new.md": "新本文" });
    const code = await runInjectSourceCli(["apply", source.id, "--file", "new.md", "--expected-revision", source.revision], t.io);
    expect(code).toBe(1);
    expect(t.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(t.err[0]).toContain("d".repeat(64));
  });

  it("apply は --file と --expected-revision が無ければ何も送らない", async () => {
    const t = fakeIo([]);
    expect(await runInjectSourceCli(["apply", source.id, "--file", "new.md"], t.io)).toBe(2);
    expect(t.calls).toHaveLength(0);
  });

  it("history は版一覧を 1 行ずつ出す", async () => {
    const t = fakeIo([{ status: 200, body: { versions: [
      { version_id: 2, parent_version_id: 1, revision: "r2", actor: "unknown", change_kind: "edit", created_at: 0 },
    ] } }]);
    expect(await runInjectSourceCli(["history", source.id, "--limit", "5"], t.io)).toBe(0);
    expect(t.calls[0]!.url).toContain("/history?limit=5");
    expect(t.out[0]).toMatch(/^2\tparent=1\tedit\tunknown\t1970-01-01T00:00:00.000Z\tr2$/);
  });
});
