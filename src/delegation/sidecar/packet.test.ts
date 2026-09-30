import { describe, expect, it } from "vitest";
import { parseSidecarPacket, renderSidecarPacket, sidecarRequestKey, SIDECAR_RETURN_FIELDS } from "./packet.js";

function validPacket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_reference: "actio:2261f19a-e365-4302-8e8f-065c01354f9e",
    request_version: 1,
    authorization_ref: "discord:example-message",
    repo_path: "E:/Document/Ars/Concordia",
    origin: "https://github.com/LUDIARS/Concordia.git",
    base_commit: "108b43bd37dd77eaccf792067b02c4a3d189940c",
    editable_paths: ["web/src/pages/Sessions.tsx"],
    child_branch: "sidecar/sessions-label",
    objective: "セッション一覧のラベル文言を仕様どおりに直す",
    design_refs: ["spec/ux/product.md"],
    acceptance: ["一覧の見出しが仕様の文言と一致する"],
    forbidden: ["他ページの編集"],
    open_questions: [],
    verification: "テストは実行しない",
    completion_scope: "commit + Revisor local PR 提出まで",
    budget: { max_minutes: 20 },
    ...overrides,
  };
}

describe("sidecar packet", () => {
  it("parses a complete packet", () => {
    const parsed = parseSidecarPacket(validPacket());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.packet.budget).toEqual({ max_minutes: 20 });
      expect(sidecarRequestKey(parsed.packet)).toBe("actio:2261f19a-e365-4302-8e8f-065c01354f9e#v1");
    }
  });

  it("reports every missing required field at once", () => {
    const parsed = parseSidecarPacket({ objective: "x" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const fields = parsed.issues.map((issue) => issue.field);
      for (const field of ["task_reference", "request_version", "authorization_ref", "repo_path", "origin",
        "base_commit", "editable_paths", "child_branch", "acceptance", "verification", "completion_scope"]) {
        expect(fields).toContain(field);
      }
    }
  });

  it.each([
    [{ base_commit: "main" }, "base_commit"],
    [{ child_branch: "main" }, "child_branch"],
    [{ child_branch: "a..b" }, "child_branch"],
    [{ request_version: 0 }, "request_version"],
    [{ editable_paths: [] }, "editable_paths"],
    [{ acceptance: "one" }, "acceptance"],
    [{ budget: { max_minutes: -1 } }, "budget.max_minutes"],
  ])("rejects invalid values (%#)", (override, field) => {
    const parsed = parseSidecarPacket(validPacket(override));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.map((issue) => issue.field)).toContain(field);
  });

  it("refuses to copy secret-like values into the packet", () => {
    // 検知対象の形は実行時に組み立て、ソースに鍵形式の文字列を置かない。
    const secretLike = ["sk", "x".repeat(24)].join("-");
    const parsed = parseSidecarPacket(validPacket({ forbidden: [`token ${secretLike}`] }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues).toContainEqual({ field: "sidecar_packet", problem: "secret_like" });
  });

  it("renders static rules before the variable request and lists every return field", () => {
    const parsed = parseSidecarPacket(validPacket());
    if (!parsed.ok) throw new Error("fixture must parse");
    const text = renderSidecarPacket(parsed.packet);
    expect(text.indexOf("## Sidecar 委任契約")).toBeLessThan(text.indexOf("## 依頼"));
    for (const field of SIDECAR_RETURN_FIELDS) expect(text).toContain(`- ${field}`);
    expect(text).toContain("sidecar/sessions-label");
    expect(text).toContain("20 分");
  });
});
