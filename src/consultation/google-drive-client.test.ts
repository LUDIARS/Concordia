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
  it("finds the linked folder by its app property across My Drive and shared drives, without a parent", async () => {
    const { fetchImpl, calls } = fakeFetch([json({ files: [{ id: "f1", webViewLink: "https://drive/f1" }] })]);
    const drive = createGoogleDriveClient(tokens, fetchImpl);
    expect(await drive.findFolders({ key: "ccConsultationId", value: "pc_1" })).toEqual([{ id: "f1", url: "https://drive/f1" }]);
    const { url, init } = calls[0]!;
    expect(url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(url.searchParams.get("corpora")).toBe("allDrives");
    expect(url.searchParams.get("q")).not.toContain("in parents");
    expect(url.searchParams.get("q")).toContain("appProperties has { key='ccConsultationId' and value='pc_1' }");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("reads the shared folder with its edit capability, and returns null when Cc cannot reach it", async () => {
    const { fetchImpl, calls } = fakeFetch([
      json({ id: "f2", webViewLink: "https://drive/f2", mimeType: "application/vnd.google-apps.folder", trashed: false, capabilities: { canAddChildren: true }, appProperties: { ccConsultationId: "pc_1" } }),
      new Response("not found", { status: 404 }),
    ]);
    const drive = createGoogleDriveClient(tokens, fetchImpl);
    expect(await drive.getFolder("f2")).toEqual({
      id: "f2", url: "https://drive/f2", mimeType: "application/vnd.google-apps.folder", trashed: false, canAddChildren: true, appProperties: { ccConsultationId: "pc_1" },
    });
    expect(calls[0]!.url.pathname).toBe("/drive/v3/files/f2");
    expect(calls[0]!.url.searchParams.get("fields")).toContain("capabilities(canAddChildren)");
    expect(await drive.getFolder("missing")).toBeNull();
  });

  it("sets and clears app properties without creating folders or permissions", async () => {
    const { fetchImpl, calls } = fakeFetch([json({ id: "f2" })]);
    await createGoogleDriveClient(tokens, fetchImpl).setAppProperties("f2", { ccConsultationId: null });
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(calls[0]!.url.pathname).toBe("/drive/v3/files/f2");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ appProperties: { ccConsultationId: null } });
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
    const { fetchImpl } = fakeFetch([
      new Response("quota secret", { status: 403 }), new Response("x", { status: 500 }), new Response("gone", { status: 404 }),
    ]);
    const drive = createGoogleDriveClient(tokens, fetchImpl);
    await expect(drive.download("a")).rejects.toMatchObject({ code: "unauthorized", status: 403 });
    const error = await drive.download("a").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DriveTransferError);
    expect((error as DriveTransferError).code).toBe("rejected");
    expect((error as Error).message).not.toContain("secret");
    // Outside getFolder a 404 is still a failure.
    await expect(drive.download("a")).rejects.toMatchObject({ code: "rejected", status: 404 });
  });
});

describe("driveQueryLiteral", () => {
  it("escapes quotes and backslashes", () => {
    expect(driveQueryLiteral("a'b\\c")).toBe("'a\\'b\\\\c'");
  });
});
