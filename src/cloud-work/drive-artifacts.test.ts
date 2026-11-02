import { describe, expect, it, vi } from "vitest";
import { DriveCloudArtifacts } from "./drive-artifacts.js";
import { cloudTargetFixture } from "../../tests/helpers/cloud-target-fixture.js";
import type { CloudTarget } from "./runtime-config.js";

const tokens = { accessToken: async () => "access-token" };
const SESSION = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=";

function driveTarget(): CloudTarget {
  return { ...cloudTargetFixture(), transferMode: "drive", storage: undefined,
    drive: { folderId: "folder_0123456789", clientIdEnv: "G_ID", clientSecretEnv: "G_SECRET", refreshTokenEnv: "G_REFRESH" } };
}

describe("Drive artifact transfer", () => {
  it("opens one upload session per file, tags it with the attempt and never reveals the credential", async () => {
    let n = 0;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 200, headers: { location: `${SESSION}${++n}` } }));
    const prompt = await new DriveCloudArtifacts(driveTarget(), ["scene.blend"], tokens, fetcher).uploadInstructions("attempt-1");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const metadata = JSON.parse(String(fetcher.mock.calls[1][1]!.body));
    expect(metadata).toMatchObject({ parents: ["folder_0123456789"],
      appProperties: { ccTarget: "tokyo-codex", ccAttempt: "attempt-1", ccName: "result.json" } });
    expect(fetcher.mock.calls[0][1]!.redirect).toBe("error");
    expect(prompt).toContain(`${SESSION}1`);
    expect(prompt).toContain("result.json LAST");
    expect(prompt).not.toContain("access-token");
  });
  it("rejects unsafe attempt IDs and unexpected session locations", async () => {
    const adapter = (fetcher: typeof fetch) => new DriveCloudArtifacts(driveTarget(), ["scene.blend"], tokens, fetcher);
    await expect(adapter(vi.fn()).uploadInstructions("../escape")).rejects.toThrow("invalid_cloud_object");
    const elsewhere = vi.fn<typeof fetch>(async () => new Response(null, { headers: { location: "https://evil.example/upload" } }));
    await expect(adapter(elsewhere).uploadInstructions("attempt-1")).rejects.toThrow("cloud_drive_upload_unavailable");
  });
  it("collects the manifest first from files located by attempt tags", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ files: [
        { id: "f-manifest", appProperties: { ccName: "result.json" } }, { id: "f-blend", appProperties: { ccName: "scene.blend" } }] }))
      .mockResolvedValueOnce(Response.json({ version: 1 }))
      .mockResolvedValueOnce(new Response("BLEND"));
    const result = await new DriveCloudArtifacts(driveTarget(), ["scene.blend"], tokens, fetcher).collect("attempt-1");
    expect(decodeURIComponent(String(fetcher.mock.calls[0][0]))).toContain("value='attempt-1'");
    expect(String(fetcher.mock.calls[1][0])).toContain("/f-manifest?alt=media");
    expect(result.received.get("scene.blend")?.toString()).toBe("BLEND");
    expect(fetcher.mock.calls[2][1]!.redirect).toBe("error");
  });
  it("refuses duplicate or stray files instead of guessing", async () => {
    const duplicate = vi.fn<typeof fetch>(async () => Response.json({ files: [
      { id: "a", appProperties: { ccName: "scene.blend" } }, { id: "b", appProperties: { ccName: "scene.blend" } }] }));
    await expect(new DriveCloudArtifacts(driveTarget(), ["scene.blend"], tokens, duplicate).collect("attempt-1"))
      .rejects.toThrow("cloud_drive_artifact_ambiguous");
    const stray = vi.fn<typeof fetch>(async () => Response.json({ files: [{ id: "a", appProperties: { ccName: "other.bin" } }] }));
    await expect(new DriveCloudArtifacts(driveTarget(), ["scene.blend"], tokens, stray).collect("attempt-1"))
      .rejects.toThrow("cloud_drive_artifact_ambiguous");
  });
  it("enforces the total byte budget", async () => {
    const target = { ...driveTarget(), maxArtifactBytes: 3 };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ files: [
        { id: "m", appProperties: { ccName: "result.json" } }, { id: "b", appProperties: { ccName: "scene.blend" } }] }))
      .mockResolvedValueOnce(Response.json({ version: 1 }))
      .mockResolvedValueOnce(new Response("TOO-LARGE"));
    await expect(new DriveCloudArtifacts(target, ["scene.blend"], tokens, fetcher).collect("attempt-1"))
      .rejects.toThrow("cloud_artifact_collection_failed");
  });
});
