import type { ForumTagState } from "./forum-system-tag.js";

const planning = new Set(["議論", "企画/議論", "企画／議論", "discussion"]);
const improvement = new Set(["改善", "改善/議論", "改善／議論", "improvement"]);
const retired = new Set(["壁打ち", "sparring", "学習", "learning"]);
const normalized = (name: string): string => name.trim().toLowerCase();

/** @implements CC-FORUM-TYPE-01 — Di の企画議論をコード作業の起動要求に変換しない。 */
export function forumDiscussionSpawnPolicy(state: ForumTagState): "ordinary" | "pending" | "planning" | "improvement" {
  const kinds = state.availableTags.filter(t => planning.has(normalized(t.name)) || improvement.has(normalized(t.name)) || retired.has(normalized(t.name)));
  if (!kinds.length) return "ordinary";
  const selected = kinds.filter(t => state.appliedTags.includes(t.id));
  if (selected.length !== 1) return "pending";
  const name = normalized(selected[0].name);
  return planning.has(name) ? "planning" : improvement.has(name) ? "improvement" : "pending";
}

export function shouldResumeForumSpawn(before: ForumTagState, after: ForumTagState): boolean {
  return forumDiscussionSpawnPolicy(after) === "improvement" && forumDiscussionSpawnPolicy(before) !== "improvement";
}
