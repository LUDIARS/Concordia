import { describe, expect, it } from "vitest";
import { approvalRejectedComment, pullRequestTitle, sanitizeGithubPublicText } from "./text.js";

describe("sanitizeGithubPublicText", () => {
  it("redacts credentials, local paths and private endpoints before GitHub publication", () => {
    const text = sanitizeGithubPublicText(
      "token=supersecret at E:/Document/Ars/private.log via http://127.0.0.1:11111/internal",
    );
    expect(text).not.toContain("supersecret");
    expect(text).not.toContain("E:/Document");
    expect(text).not.toContain("127.0.0.1");
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("[LOCAL_PATH]");
    expect(text).toContain("[PRIVATE_ENDPOINT]");
  });
});

describe("approvalRejectedComment", () => {
  it("redacts sensitive text before publishing the rejection reason", () => {
    const text = approvalRejectedComment(
      "token=supersecret at E:/Document/Ars/private.log via http://127.0.0.1:11111/internal",
    );
    expect(text).not.toContain("supersecret");
    expect(text).not.toContain("E:/Document");
    expect(text).not.toContain("127.0.0.1");
  });
});

describe("pullRequestTitle", () => {
  it("preserves a feature request title without mislabeling it as a fix", () => {
    const run = { issue_number: 42, issue_title: "ダッシュボードを追加" };

    expect(pullRequestTitle(run)).toBe("ダッシュボードを追加 (#42)");
  });
});
