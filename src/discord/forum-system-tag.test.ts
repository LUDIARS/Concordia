import { describe, expect, it, vi } from "vitest";
import {
  CONCORDIA_MANAGED_FORUM_TAG_NAME,
  hasConcordiaManagedForumTag,
  markForumThreadAsConcordiaManaged,
  type EditableForumThread,
} from "./forum-system-tag.js";

describe("Cc managed Forum tag", () => {
  it("detects and persistently adds the marker without dropping existing tags", async () => {
    const edit = vi.fn(async () => undefined);
    const fresh: EditableForumThread = {
      id: "thread-1",
      appliedTags: ["work-tag"],
      availableTags: [{ id: "managed-tag", name: CONCORDIA_MANAGED_FORUM_TAG_NAME }],
      fetch: async () => fresh,
      edit,
    };

    expect(hasConcordiaManagedForumTag(fresh)).toBe(false);
    await markForumThreadAsConcordiaManaged(fresh);
    expect(edit).toHaveBeenCalledWith({
      appliedTags: ["work-tag", "managed-tag"],
      reason: "Concordia explicit spawn",
    });
  });

  it("fails instead of launching when the required tag is unavailable", async () => {
    const thread: EditableForumThread = {
      id: "thread-1",
      appliedTags: [],
      availableTags: [],
      fetch: async () => thread,
      edit: vi.fn(),
    };
    await expect(markForumThreadAsConcordiaManaged(thread)).rejects.toThrow("Cc管理");
  });
});
