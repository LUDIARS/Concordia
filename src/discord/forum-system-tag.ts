/**
 * Concordia が所有・管理する Forum thread を表す永続マーカー。
 *
 * ThreadCreate と slash command は別イベントなので、プロセス内の時刻や channel id では
 * 相関させない。Discord 上の applied tag を両経路が共有する単一情報源にする。
 */
export const CONCORDIA_MANAGED_FORUM_TAG_NAME = "Cc管理";

export interface ForumTagIdentity {
  id: string;
  name: string;
}

export interface ForumTagState {
  appliedTags: readonly string[];
  availableTags: readonly ForumTagIdentity[];
}

export interface EditableForumThread extends ForumTagState {
  id: string;
  fetch: () => Promise<EditableForumThread>;
  edit: (patch: { appliedTags: string[]; reason?: string }) => Promise<unknown>;
}

export function concordiaManagedTagId(state: Pick<ForumTagState, "availableTags">): string | null {
  return state.availableTags.find((tag) => tag.name === CONCORDIA_MANAGED_FORUM_TAG_NAME)?.id ?? null;
}

export function hasConcordiaManagedForumTag(state: ForumTagState): boolean {
  const tagId = concordiaManagedTagId(state);
  return tagId !== null && state.appliedTags.includes(tagId);
}

/**
 * Explicit `/spawn` の対象 thread を Cc 管理対象として永続化する。
 * fetch 後の appliedTags を基準に edit し、並行して付いた利用者タグを落とさない。
 */
export async function markForumThreadAsConcordiaManaged(thread: EditableForumThread): Promise<void> {
  const fresh = await thread.fetch();
  const tagId = concordiaManagedTagId(fresh);
  if (!tagId) {
    throw new Error(`Forum is missing required tag: ${CONCORDIA_MANAGED_FORUM_TAG_NAME}`);
  }
  if (fresh.appliedTags.includes(tagId)) return;
  await fresh.edit({
    appliedTags: [...fresh.appliedTags, tagId],
    reason: "Concordia explicit spawn",
  });
}
