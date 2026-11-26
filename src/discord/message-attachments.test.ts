import { describe, expect, it } from "vitest";
import { describeMessageAttachments, splitMessageAttachments } from "./message-attachments.js";

const png = { id: "a1", name: "shot.png", contentType: "image/png", size: 10, url: "https://cdn.discordapp.com/a/shot.png" };
const jpgByName = { id: "a2", name: "photo.JPG", contentType: null, size: 20, url: "https://cdn.discordapp.com/a/photo.JPG" };
const pdf = { id: "a3", name: "spec.pdf", contentType: "application/pdf", size: 30, url: "https://cdn.discordapp.com/a/spec.pdf" };

describe("splitMessageAttachments", () => {
  it("separates images (by type or extension) from other files", () => {
    const { images, files } = splitMessageAttachments([png, jpgByName, pdf]);
    expect(images.map((image) => image.name)).toEqual(["shot.png", "photo.JPG"]);
    expect(files.map((file) => file.name)).toEqual(["spec.pdf"]);
  });
});

describe("describeMessageAttachments", () => {
  it("keeps id, name, type, size and kind, but never the expiring CDN URL", () => {
    expect(describeMessageAttachments([png, pdf])).toEqual([
      { id: "a1", name: "shot.png", content_type: "image/png", size: 10, kind: "image" },
      { id: "a3", name: "spec.pdf", content_type: "application/pdf", size: 30, kind: "file" },
    ]);
  });
});
