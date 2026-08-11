import { describe, expect, it } from "vitest";
import { SessionMessageService } from "../src/messages/service.js";
import { projectDelegationSessionLinks } from "../src/delegation/session-links.js";
import { makeTestApp } from "./helpers/test-app.js";

function insertSession(env: ReturnType<typeof makeTestApp>, id: string): void {
  env.repo.insertSession({
    id,
    provider: "codex-cli",
    repo_path: "/workspace/project",
    repo_origin: null,
    branch: "main",
    host: "host",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    metadata: null,
  });
}

function createRun(
  env: ReturnType<typeof makeTestApp>,
  input: {
    id?: string;
    parentSessionId?: string | null;
    childSessionId?: string | null;
  } = {},
) {
  const childSessionId = input.childSessionId ?? null;
  return env.delegation.createRun({
    id: input.id ?? "run-links-1",
    template_id: null,
    call_name: "implement",
    target_provider: "codex",
    parent_session_id: input.parentSessionId === undefined
      ? "parent-session"
      : input.parentSessionId,
    child_session_id: childSessionId,
    args: {},
    rendered_prompt: "prompt",
    prompt_file_path: "/tmp/prompt.md",
    spawn_pid: null,
    spawn_command: null,
    triggered_by: null,
    status: childSessionId ? "running" : "spawned",
  });
}

describe("delegation session links", () => {
  it("claims a child into D1 and writes one link message to both sessions", async () => {
    const env = makeTestApp();
    insertSession(env, "parent-session");
    createRun(env);

    const response = await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "child-session",
        provider: "codex-cli",
        repo_path: "/workspace/project-child",
        host: "host",
        metadata: { delegation_run_id: "run-links-1" },
      }),
    });

    expect(response.status).toBe(200);
    const parentMessages = env.sessionMessages.list("parent-session");
    const childMessages = env.sessionMessages.list("child-session");
    expect(parentMessages).toHaveLength(1);
    expect(childMessages).toHaveLength(1);
    expect(parentMessages[0]).toMatchObject({
      author_type: "delegation",
      dedupe_key: "delegation:run-links-1:parent",
      metadata: {
        run_id: "run-links-1",
        parent_session_id: "parent-session",
        child_session_id: "child-session",
      },
    });
    expect(childMessages[0]).toMatchObject({
      author_type: "delegation",
      dedupe_key: "delegation:run-links-1:child",
      metadata: parentMessages[0].metadata,
    });
  });

  it("keeps one row per side when the same run is projected again", () => {
    const env = makeTestApp();
    insertSession(env, "parent-session");
    insertSession(env, "child-session");
    const run = createRun(env);
    const claimed = env.delegation.claimChildSession(run.id, "child-session");
    if (!claimed) throw new Error("expected delegation run");
    const service = new SessionMessageService({ repo: env.sessionMessages, emit: () => {} });

    projectDelegationSessionLinks(claimed, (event) => service.project(event), 10);
    projectDelegationSessionLinks(claimed, (event) => service.project(event), 11);

    expect(env.sessionMessages.list("parent-session")).toHaveLength(1);
    expect(env.sessionMessages.list("child-session")).toHaveLength(1);
  });

  it("returns only claimed parent and child links from either session", async () => {
    const env = makeTestApp();
    insertSession(env, "parent-session");
    insertSession(env, "child-session");
    const run = createRun(env);
    env.delegation.claimChildSession(run.id, "child-session");
    createRun(env, { id: "run-without-child" });
    createRun(env, {
      id: "run-without-parent",
      parentSessionId: null,
      childSessionId: "child-session",
    });

    const parentResponse = await env.app.request("/v1/sessions/parent-session/links");
    expect(parentResponse.status).toBe(200);
    const parentLinks = await parentResponse.json();
    expect(parentLinks.children).toHaveLength(1);
    expect(parentLinks).toMatchObject({
      parents: [],
      children: [{ run_id: "run-links-1", session_id: "child-session" }],
    });

    const childResponse = await env.app.request("/v1/sessions/child-session/links");
    expect(childResponse.status).toBe(200);
    const childLinks = await childResponse.json();
    expect(childLinks.parents).toHaveLength(1);
    expect(childLinks).toMatchObject({
      parents: [{ run_id: "run-links-1", session_id: "parent-session" }],
      children: [],
    });
  });
});
