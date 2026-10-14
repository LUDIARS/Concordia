import { describe, expect, it, vi } from "vitest";
import { DriveTransferError } from "./drive-transfer-port.js";
import { createGoogleDriveClient, driveQueryLiteral } from "./google-drive-client.js";

const tokens = { token: async () => "tok" };

function fakeFetch(responses: Array<Response | (() => Response)>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string, init: RequestInit) => {
    calls.push({ url: new URL(input), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    return typeof next === "function" ? next() : next;
  });
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("createGoogleDriveClient", () => {
  it("finds the consultation folder by its app property inside the parent, across shared drives", async () => {
    const { fetchImpl, calls } = fakeFetch([json({ files: [{ id: "f1", webViewLink: "https://drive/f1" }] })]);
    const drive = createGoogleDriveClient(tokens, fetchImpl);
    expect(await drive.findFolder("parent1", { key: "ccConsultationId", value: "pc_1" })).toEqual({ id: "f1", url: "https://drive/f1" });
    const { url, init } = calls[0]!;
    expect(url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(url.searchParams.get("q")).toContain("'parent1' in parents");
    expect(url.searchParams.get("q")).toContain("appProperties has { key='ccConsultationId' and value='pc_1' }");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("creates a folder and shares it to one user without a link permission", async () => {
    const { fetchImpl, calls } = fakeFetch([json({ id: "f2" }), json({ id: "perm" })]);
    const drive = createGoogleDriveClient(tokens, fetchImpl);
    const folder = await drive.createFolder("parent1", "相談-20261014-abcdef", { ccConsultationId: "pc_1" });
    expect(folder).toEqual({ id: "f2", url: "https://drive.google.com/drive/folders/f2" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      name: "相談-20261014-abcdef", mimeType: "application/vnd.google-apps.folder", parents: ["parent1"], appProperties: { ccConsultationId: "pc_1" },
    });
    await drive.share("f2", { type: "user", role: "writer", emailAddress: "a@example.com" });
    expect(calls[1]!.url.pathname).toBe("/drive/v3/files/f2/permissions");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ type: "user", role: "writer", emailAddress: "a@example.com" });
  });

  it("lists every page of the folder and reads sizes and app properties", async () => {
    const { fetchImpl, calls } = fakeFetch([
      json({ nextPageToken: "p2", files: [{ id: "a", name: "a.wav", mimeType: "audio/wav", size: "10", appProperties: { ccImported: "1" } }] }),
      json({ files: [{ id: "b", name: "doc", mimeType: "application/vnd.google-apps.document" }] }),
    ]);
    const files = await createGoogleDriveClient(tokens, fetchImpl).listFiles("f1");
    expect(files).toEqual([
      { id: "a", name: "a.wav", mimeType: "audio/wav", size: 10, appProperties: { ccImported: "1" } },
      { id: "b", name: "doc", mimeType: "application/vnd.google-apps.document", size: null, appProperties: {} },
    ]);
    expect(calls[1]!.url.searchParams.get("pageToken")).toBe("p2");
  });

  it("uploads as multipart with the metadata and the bytes", async () => {
    const { fetchImpl, calls } = fakeFetch([json({ id: "up1" })]);
    const result = await createGoogleDriveClient(tokens, fetchImpl).upload("f1", {
      name: "fixed.glb", bytes: new Uint8Array([1, 2, 3]), appProperties: { ccKind: "answer" },
    });
    expect(result).toEqual({ id: "up1" });
    const { url, init } = calls[0]!;
    expect(url.pathname).toBe("/upload/drive/v3/files");
    expect(url.searchParams.get("uploadType")).toBe("multipart");
    const body = Buffer.from(init.body as Uint8Array).toString("latin1");
    expect(body).toContain('"name":"fixed.glb"');
    expect(body).toContain('"parents":["f1"]');
    expect(body).toContain("\u0001\u0002\u0003");
  });

  it("maps HTTP failures to codes without the response body", async () => {
    const { fetchImpl } = fakeFetch([new Response("quota secret", { status: 403 }), new Response("x", { status: 500 })]);
    const drive = createGoogleDriveClient(tokens, fetchImpl);
    await expect(drive.download("a")).rejects.toMatchObject({ code: "unauthorized", status: 403 });
    const error = await drive.download("a").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DriveTransferError);
    expect((error as DriveTransferError).code).toBe("rejected");
    expect((error as Error).message).not.toContain("secret");
  });
});

describe("driveQueryLiteral", () => {
  it("escapes quotes and backslashes", () => {
    expect(driveQueryLiteral("a'b\\c")).toBe("'a\\'b\\\\c'");
  });
});
