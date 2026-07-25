import { describe, expect, it, vi } from "vitest";
import {
  desiredSessionForumTagNames,
  forumTemplateDefaultArgs,
  syncSessionForumTemplateTags,
  validateForumTemplateTags,
  type ForumTemplateTagSource,
} from "./forum-template-tags.js";
import { CONCORDIA_MANAGED_FORUM_TAG_NAME } from "./forum-system-tag.js";

function template(index: number, patch: Partial<ForumTemplateTagSource> = {}): ForumTemplateTagSource {
  return {
    id: `t${index}`,
    call_name: `template-${index}`,
    title: `Template ${index}`,
    is_active: true,
    forum_tag: true,
    input_schema: [],
    ...patch,
  };
}

describe("forum template tags", () => {
  it("combines fixed work/state tags with enabled template tags", () => {
    expect(desiredSessionForumTagNames([template(1), template(2, { is_active: false })])).toEqual([
      "設計相談", "実装", "レビュー", "テスト", "雑用",
      "作業中", "待機", "lost",
      CONCORDIA_MANAGED_FORUM_TAG_NAME,
      "Template 1",
    ]);
  });

  it("rejects more than ten active templates and duplicate labels", () => {
    expect(validateForumTemplateTags(Array.from({ length: 11 }, (_, index) => template(index))).ok).toBe(false);
    expect(validateForumTemplateTags([
      template(1, { title: "same" }),
      template(2, { title: "SAME" }),
    ])).toMatchObject({ ok: false, error: "duplicate forum_tag title: SAME" });
    expect(validateForumTemplateTags([
      template(3, { title: CONCORDIA_MANAGED_FORUM_TAG_NAME }),
    ])).toMatchObject({ ok: false, error: `forum_tag title is reserved: ${CONCORDIA_MANAGED_FORUM_TAG_NAME}` });
  });

  it("keeps the maximum required tag set within Discord's limit", () => {
    expect(desiredSessionForumTagNames(Array.from({ length: 10 }, (_, index) => template(index))))
      .toHaveLength(19);
  });

  it("includes the Cc-managed marker in API tag sync", async () => {
    const patch = vi.fn(async () => undefined);
    const result = await syncSessionForumTemplateTags({
      token: "token",
      forumId: "forum-1",
      templates: [template(1)],
      rest: {
        get: vi.fn(async () => ({ id: "forum-1", available_tags: [] })),
        patch,
      } as never,
    });
    expect(result.tags).toContain(CONCORDIA_MANAGED_FORUM_TAG_NAME);
    expect(patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.objectContaining({
          available_tags: expect.arrayContaining([
            expect.objectContaining({ name: CONCORDIA_MANAGED_FORUM_TAG_NAME }),
          ]),
        }),
      }),
    );
  });

  it("requires defaults for template arguments and builds invoke args from them", () => {
    const invalid = template(1, {
      input_schema: [{ name: "task", type: "string", required: true }],
    });
    expect(validateForumTemplateTags([invalid])).toMatchObject({ ok: false });

    const valid = template(2, {
      input_schema: [
        { name: "effort", type: "string", required: true, default: "high" },
        { name: "dry_run", type: "boolean", required: false, default: false },
      ],
    });
    expect(validateForumTemplateTags([valid])).toEqual({ ok: true });
    expect(forumTemplateDefaultArgs(valid)).toEqual({ effort: "high", dry_run: false });
  });
});
