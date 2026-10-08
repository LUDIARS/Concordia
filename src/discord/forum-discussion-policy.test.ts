import { describe, expect, it } from "vitest";
import { forumDiscussionSpawnPolicy, shouldResumeForumSpawn } from "./forum-discussion-policy.js";
const availableTags = [{ id: "p", name: "議論" }, { id: "i", name: "改善" }, { id: "s", name: "壁打ち" }];
const state = (...appliedTags: string[]) => ({ appliedTags, availableTags });
describe("CC-FORUM-TYPE-01", () => {
  it("keeps ordinary forums unchanged", () => expect(forumDiscussionSpawnPolicy({ appliedTags: [], availableTags: [] })).toBe("ordinary"));
  it("waits for one supported type", () => {
    for (const tags of [[], ["p", "i"], ["s"]]) expect(forumDiscussionSpawnPolicy(state(...tags))).toBe("pending");
  });
  it("leaves projectless planning to Di", () => expect(forumDiscussionSpawnPolicy(state("p"))).toBe("planning"));
  it("resumes only on a transition into improvement", () => {
    expect(shouldResumeForumSpawn(state(), state("i"))).toBe(true);
    expect(shouldResumeForumSpawn(state(), state("p"))).toBe(false);
    expect(shouldResumeForumSpawn(state("i"), state("i"))).toBe(false);
  });
});
