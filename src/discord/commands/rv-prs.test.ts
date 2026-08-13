import { afterEach, describe, expect, it, vi } from "vitest";
import rvPrsCommand from "./rv-prs.js";

function interaction(repository: string | null = null) {
  return {
    deferReply: vi.fn(async (_options: unknown) => undefined),
    editReply: vi.fn(async (_payload: unknown) => undefined),
    options: { getString: vi.fn((_name: string) => repository) },
  };
}

describe("/rv-prs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares valid slash-command metadata", () => {
    const json = rvPrsCommand.builder.toJSON() as {
      name: string;
      description: string;
      options?: unknown[];
    };
    expect(json.name).toBe("rv-prs");
    expect(json.description).toContain("Revisor local PR");
    expect(json.options?.[0]).toMatchObject({ name: "repository", required: false });
  });

  it("renders a successful digest even though the payload has error: null", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({
        markdown: "## Revisor local PR 一覧",
        open_count: 1,
        error: null,
      })));
    vi.stubGlobal("fetch", fetchMock);
    const i = interaction("LUDIARS/Concordia");

    await rvPrsCommand.execute(i as never, { concordiaUrl: "http://concordia.test" } as never);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://concordia.test/v1/prs/revisor/digest?repository=LUDIARS%2FConcordia",
    );
    expect(i.editReply).toHaveBeenCalledWith({
      content: "## Revisor local PR 一覧",
      allowedMentions: { parse: [] },
    });
  });

  it("does not expose raw connection errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect failed at http://secret.invalid/private");
    }));
    const i = interaction();

    await rvPrsCommand.execute(i as never, { concordiaUrl: "http://concordia.test" } as never);

    const reply = i.editReply.mock.calls[0]?.[0] as { content: string };
    expect(reply.content).toContain("取得に失敗しました");
    expect(reply.content).not.toContain("secret.invalid");
    expect(reply.content).not.toContain("/private");
  });

  it("handles a malformed successful response without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("null")));
    const i = interaction();

    await rvPrsCommand.execute(i as never, { concordiaUrl: "http://concordia.test" } as never);

    expect(i.editReply).toHaveBeenCalledWith({
      content: "Revisor local PR 一覧の取得に失敗しました。Concordia の状態を確認してください。",
      allowedMentions: { parse: [] },
    });
  });
});
