/** Test Forum で Cc が所有する審査状態タグと、その適用差分。 */

export const TEST_FORUM_STATUS_TAG_NAMES = [
  "審査中",
  "審査失敗",
  "人間判断",
  "マージOK",
  "テストOK",
] as const;

type TestForumStatusTagName = typeof TEST_FORUM_STATUS_TAG_NAMES[number];

interface ForumTag {
  id: string;
  name: string;
}

const MANAGED_TAG_NAMES = new Set<string>(TEST_FORUM_STATUS_TAG_NAMES);

export function desiredTestForumStatusTags(
  checkStatus: string,
  mergeable: boolean,
): TestForumStatusTagName[] {
  if (checkStatus === "failed") return ["審査失敗"];
  if (checkStatus === "action_required") return ["人間判断"];
  if (checkStatus === "test_ok") {
    return mergeable ? ["テストOK", "マージOK"] : ["テストOK"];
  }
  return ["審査中"];
}

/** Cc 管理タグだけを置換し、手動タグや別機能のタグは維持する。 */
export function reconcileTestForumTagIds(
  availableTags: readonly ForumTag[],
  appliedTagIds: readonly string[],
  checkStatus: string,
  mergeable: boolean,
): string[] {
  const availableByName = new Map(availableTags.map((tag) => [tag.name, tag.id]));
  const managedIds = new Set(
    availableTags.filter((tag) => MANAGED_TAG_NAMES.has(tag.name)).map((tag) => tag.id),
  );
  const desiredIds = desiredTestForumStatusTags(checkStatus, mergeable).map((name) => {
    const id = availableByName.get(name);
    if (!id) throw new Error(`Test Forum status tag is unavailable: ${name}`);
    return id;
  });
  return [...new Set([
    ...appliedTagIds.filter((id) => !managedIds.has(id)),
    ...desiredIds,
  ])];
}
