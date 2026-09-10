import { describe, expect, it } from "vitest";
import { isSessionPr, isSessionTask } from "./related-work.js";

describe("session-related work", () => {
  const session = { id: "s1", repo_origin: "https://github.com/LUDIARS/Concordia.git", branch: "feat/chat" };
  const pr = { sessionId: null, repository: "LUDIARS/Concordia", headRef: "feat/chat" };
  it("requires both repository and dedicated branch when the PR is not explicitly linked to the session", () => {
    expect(isSessionPr(pr, session)).toBe(true);
    expect(isSessionPr(pr, { ...session, repo_origin: "git@github.com:LUDIARS/Concordia.git" })).toBe(true);
    expect(isSessionPr({ ...pr, repository: "LUDIARS/Lictor" }, session)).toBe(false);
    expect(isSessionPr({ ...pr, headRef: "feat/other" }, session)).toBe(false);
    expect(isSessionPr({ ...pr, headRef: "main" }, { ...session, branch: "main" })).toBe(false);
    expect(isSessionPr({ ...pr, headRef: "MAIN" }, { ...session, branch: "MAIN" })).toBe(false);
    expect(isSessionPr({ ...pr, sessionId: "s1" }, { ...session, branch: "main" })).toBe(true);
  });
  it("links taskflow records only through explicit session IDs", () => {
    expect(isSessionTask({ source_session: null, parent_session_id: "s1", child_session_id: "s2" }, "s1")).toBe(true);
    expect(isSessionTask({ source_session: null, parent_session_id: "s1", child_session_id: "s2" }, "s2")).toBe(true);
    expect(isSessionTask({ source_session: "s3", parent_session_id: null, child_session_id: null }, "s1")).toBe(false);
  });
});
