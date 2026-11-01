import { describe, expect, it, vi } from "vitest";
import { checkFetchGate, createFetchDispatcher, loadFetchPolicy, validateFetchInput } from "./consult-fetch-bridge.mjs";

const url = "https://example.notion.site/0123456789abcdef0123456789abcdef";
const script = "E:/Document/Consult/_source/tools/fetch-link/fetch-link.mjs";
const good = { status: "success", reason: null, stdout: "取得方法: Notion 読み取り API\n資料ここから\n本文\n資料ここまで", stderr: "" };
const fixture = (overrides = {}) => {
  const ports = { script, classify: vi.fn(() => ({ kind: "notion" })), gate: vi.fn(async () => true), execute: vi.fn(async () => good), ...overrides };
  return { ...ports, dispatch: createFetchDispatcher(ports) };
};
describe("Consult fetch dispatcher", () => {
  it.each([null, {}, { url, command: "anything" }, { url: "file:///etc/passwd" }, { url: "http://127.0.0.1/" }, { url: "https://user:pass@example.com/" }, { url: "https://example.com:123/" }, { url: url + "\n" }])("rejects invalid input without execution", async input => {
    const f = fixture();
    expect(validateFetchInput(input)).toBe(false);
    expect((await f.dispatch(input)).isError).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("uses the shared classification before the gate or child and preserves rejection", async () => {
    const f = fixture({ classify: () => ({ kind: "unsupported", reason: "site not registered" }) });
    expect((await f.dispatch({ url })).content[0].text).toBe("site not registered");
    expect(f.gate).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("passes fixed argv/cwd/limits and returns the same formatted output as Claude", async () => {
    const f = fixture();
    expect(await f.dispatch({ url })).toEqual({ content: [{ type: "text", text: good.stdout }] });
    expect(f.execute).toHaveBeenCalledWith({ cwd: "E:/Document/Consult/_source/tools/fetch-link", argv: [script, url], timeoutMs: 120000, outputLimit: 1048576 });
  });
  it("fails closed on gate denial", async () => {
    const f = fixture({ gate: async () => false });
    expect((await f.dispatch({ url })).isError).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(["timeout", "output-limit", "cancelled"])("does not present partial %s output as success", async reason => {
    const f = fixture({ execute: async () => ({ ...good, status: "unknown", reason }) });
    const result = await f.dispatch({ url });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain(good.stdout);
  });
  it("preserves fetcher failures and never exposes raw stderr", async () => {
    const f = fixture({ execute: async () => ({ ...good, status: "failed", stdout: "取得できませんでした", stderr: "secret" }) });
    expect(await f.dispatch({ url })).toEqual({ isError: true, content: [{ type: "text", text: "取得できませんでした" }] });
  });
  it("does not execute a request cancelled during gate evaluation", async () => {
    const controller = new AbortController();
    const f = fixture({ gate: async () => { controller.abort(); return true; } });
    expect((await f.dispatch({ url }, { signal: controller.signal })).isError).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("rejects overlapping requests and releases ownership after completion", async () => {
    let finish;
    const f = fixture({ gate: () => new Promise(resolve => { finish = resolve; }) });
    const first = f.dispatch({ url });
    expect((await f.dispatch({ url })).isError).toBe(true);
    finish(true);
    expect((await first).isError).toBeUndefined();
    const next = f.dispatch({ url }); finish(false);
    expect((await next).isError).toBe(true);
  });
  it("rejects noncanonical configured scripts before import", async () => {
    await expect(loadFetchPolicy("./other.mjs")).rejects.toThrow();
    await expect(loadFetchPolicy("E:/tmp/other.mjs")).rejects.toThrow();
  });
});
describe("bridge gate", () => {
  const env = { CONCORDIA_SESSION_ID: "test-session", CONCORDIA_URL: "http://cc.test" };
  const response = body => ({ ok: true, json: async () => body });
  it("requires active identity and an affirmative gate", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ session: { status: "active" } })).mockResolvedValueOnce(response({ decision: "allow", blocked: false }));
    expect(await checkFetchGate(env, url, fetchImpl)).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).action).toEqual({ tool: "mcp__consult_fetch_link__fetch_link", command: url });
  });
  it("rejects missing identity, ended session, denial and connection failure", async () => {
    expect(await checkFetchGate({}, url, vi.fn())).toBe(false);
    expect(await checkFetchGate(env, url, async () => response({ session: { status: "ended" } }))).toBe(false);
    const denied = vi.fn().mockResolvedValueOnce(response({ session: { status: "active" } })).mockResolvedValueOnce(response({ decision: "deny", blocked: true }));
    expect(await checkFetchGate(env, url, denied)).toBe(false);
    expect(await checkFetchGate(env, url, async () => { throw new Error("offline"); })).toBe(false);
  });
});
