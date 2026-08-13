import { describe, it, expect } from "vitest";
import {
  buildRevisorLocalPrDigest,
  renderRevisorLocalPrListMarkdown,
  REVISOR_PR_GUIDANCE,
} from "./local-pr-listing.js";
import type { RevisorLocalPr } from "./revisor-client.js";

function pr(overrides: Partial<RevisorLocalPr> = {}): RevisorLocalPr {
  return {
    id: "lpr-1",
    number: 1,
    repository: "LUDIARS/Concordia",
    title: "feat: something",
    author: "session",
    status: "open",
    checkStatus: "queued",
    headRef: "feat/x",
    baseRef: "main",
    headSha: "abc",
    createdAt: "2026-08-13T00:00:00Z",
    updatedAt: "2026-08-13T00:00:00Z",
    ...overrides,
  };
}

describe("renderRevisorLocalPrListMarkdown", () => {
  it("always teaches that PR means Revisor local PR", () => {
    const md = renderRevisorLocalPrListMarkdown([]);
    expect(md).toContain("Revisor local PR 一覧");
    expect(md).toContain(REVISOR_PR_GUIDANCE);
    expect(md).toContain("open な local PR はありません");
  });

  it("orders open PRs by urgency (action_required first, test_ok last)", () => {
    const md = renderRevisorLocalPrListMarkdown([
      pr({ id: "a", number: 1, checkStatus: "test_ok" }),
      pr({ id: "b", number: 2, checkStatus: "action_required" }),
      pr({ id: "c", number: 3, checkStatus: "running" }),
    ]);
    const posB = md.indexOf("#2");
    const posC = md.indexOf("#3");
    const posA = md.indexOf("#1 ");
    expect(posB).toBeGreaterThan(-1);
    expect(posB).toBeLessThan(posC);
    expect(posC).toBeLessThan(posA);
    expect(md).toContain("**open: 3 件**");
  });

  it("filters by repository accepting origin URL notation", () => {
    const md = renderRevisorLocalPrListMarkdown(
      [
        pr({ id: "a", number: 1, repository: "LUDIARS/Concordia" }),
        pr({ id: "b", number: 2, repository: "LUDIARS/Lictor" }),
      ],
      { repository: "https://github.com/LUDIARS/Concordia.git" },
    );
    expect(md).toContain("#1");
    expect(md).not.toContain("Lictor");
    expect(md).toContain("**open: 1 件**");
  });

  it("counts truncated rows instead of dropping them silently", () => {
    const many = Array.from({ length: 5 }, (_, i) => pr({ id: `p${i}`, number: i + 1 }));
    const md = renderRevisorLocalPrListMarkdown(many, { limit: 2 });
    expect(md).toContain("…他 3 件");
  });

  it("appends recently merged PRs", () => {
    const md = renderRevisorLocalPrListMarkdown([
      pr({ id: "a", number: 1 }),
      pr({ id: "b", number: 2, status: "merged", title: "merged one" }),
    ]);
    expect(md).toContain("直近 merged");
    expect(md).toContain("merged one");
  });

  it("neutralizes markdown mentions and hides local repository paths", () => {
    const md = renderRevisorLocalPrListMarkdown([
      pr({
        repository: "C:/workspace/private-repo",
        title: "@everyone\n<!channel> **review me**",
        headRef: "feat/line\nbreak",
        checkStatus: "custom\n@here",
      }),
    ]);

    expect(md).toContain("(unknown repository)");
    expect(md).toContain("\\*\\*review me\\*\\*");
    expect(md).not.toContain("C:/workspace");
    expect(md).not.toContain("@everyone");
    expect(md).not.toContain("<!channel>");
    expect(md).not.toContain("feat/line\nbreak");
  });
});

describe("buildRevisorLocalPrDigest", () => {
  it("explains when the reader is not configured", async () => {
    const digest = await buildRevisorLocalPrDigest(undefined);
    expect(digest.error).toBe("revisor_not_configured");
    expect(digest.markdown).toContain("有効になっていません");
    expect(digest.markdown).toContain(REVISOR_PR_GUIDANCE);
  });

  it("explains a fetch failure inside the markdown (no silent skip)", async () => {
    const digest = await buildRevisorLocalPrDigest({
      listLocalPrs: async () => { throw new Error("connect ECONNREFUSED http://secret.invalid/private"); },
    });
    expect(digest.error).toBe("revisor_request_failed");
    expect(digest.markdown).toContain("取得できませんでした");
    expect(digest.markdown).not.toContain("secret.invalid");
    expect(digest.markdown).not.toContain("/private");
  });

  it("returns markdown and the scoped open count", async () => {
    const digest = await buildRevisorLocalPrDigest(
      {
        listLocalPrs: async () => [
          pr({ id: "a", number: 1, repository: "LUDIARS/Concordia" }),
          pr({ id: "b", number: 2, repository: "LUDIARS/Lictor" }),
          pr({ id: "c", number: 3, repository: "LUDIARS/Concordia", status: "merged" }),
        ],
      },
      { repository: "LUDIARS/Concordia" },
    );
    expect(digest.error).toBeNull();
    expect(digest.openCount).toBe(1);
    expect(digest.markdown).toContain("#1");
  });
});
