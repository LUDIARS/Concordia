import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadSlackAttachments, type SlackFileUploadClient } from "./chat-attachments.js";

const log = () => ({ warn: vi.fn(), info: vi.fn() });

describe("uploadSlackAttachments", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-attach-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("uploads the readable files to the channel in one call and skips missing ones", async () => {
    const video = path.join(dir, "play.mp4");
    const curve = path.join(dir, "curve.json");
    fs.writeFileSync(video, Buffer.from([0, 0, 0, 1, 9]));
    fs.writeFileSync(curve, "{\"entries\":[]}");
    const filesUploadV2 = vi.fn().mockResolvedValue({ ok: true });
    const logger = log();

    const count = await uploadSlackAttachments({ filesUploadV2 }, {
      channelId: "C123",
      paths: [video, path.join(dir, "missing.txt"), curve],
      label: "message_id=1",
      workspaceRoots: [],
    }, logger);

    expect(count).toBe(2);
    expect(filesUploadV2).toHaveBeenCalledTimes(1);
    const args = filesUploadV2.mock.calls[0]![0] as Parameters<SlackFileUploadClient["filesUploadV2"]>[0];
    expect(args.channel_id).toBe("C123");
    expect(args.thread_ts).toBeUndefined();
    expect(args.file_uploads.map((f) => f.filename)).toEqual(["play.mp4", "curve.json"]);
    expect(args.file_uploads[1]!.file.toString()).toBe("{\"entries\":[]}");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("missing.txt"));
  });

  it("does not call Slack when there is nothing to upload", async () => {
    const filesUploadV2 = vi.fn();
    expect(await uploadSlackAttachments({ filesUploadV2 }, { channelId: "C1", paths: undefined, label: "m", workspaceRoots: [] }, log())).toBe(0);
    expect(await uploadSlackAttachments({ filesUploadV2 }, { channelId: "C1", paths: [path.join(dir, "none.mp4")], label: "m", workspaceRoots: [] }, log())).toBe(0);
    expect(filesUploadV2).not.toHaveBeenCalled();
  });

  it("keeps going when the upload fails (warns, returns 0)", async () => {
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "a");
    const filesUploadV2 = vi.fn().mockRejectedValue(new Error("missing_scope"));
    const logger = log();
    await expect(uploadSlackAttachments({ filesUploadV2 }, { channelId: "C1", threadTs: "1.000001", paths: [file], label: "m", workspaceRoots: [] }, logger)).resolves.toBe(0);
    expect((filesUploadV2.mock.calls[0]![0] as { thread_ts?: string }).thread_ts).toBe("1.000001");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("missing_scope"));
  });
});
