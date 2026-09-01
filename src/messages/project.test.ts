import { describe, it, expect, beforeEach } from "vitest";
import { projectEvent, ToolUseDedupeContext, type ProjectContext } from "./project.js";
import type { ConcordiaEvent } from "../events.js";

let ctx: ProjectContext;

beforeEach(() => {
  ctx = new ToolUseDedupeContext();
});

function frame(kind: string, payload: unknown, seq = 1): ConcordiaEvent {
  return { type: "transcript.frame", target_session_id: "s1", seq, kind, payload, ts: 1000 };
}

describe("projectEvent / transcript.frame", () => {
  it("kind=text role=user → author_type=user", () => {
    const [msg] = projectEvent(frame("text", { role: "user", text: "hi" }), ctx);
    expect(msg.author_type).toBe("user");
    expect(msg.op).toBe("create");
    expect(msg.dedupe_key).toBe("frame:1");
    expect(msg.content).toBe("hi");
  });

  it("kind=text role=assistant → author_type=assistant", () => {
    const [msg] = projectEvent(frame("text", { role: "assistant", text: "yo" }), ctx);
    expect(msg.author_type).toBe("assistant");
  });

  it("kind=text with unknown role is dropped", () => {
    expect(projectEvent(frame("text", { role: "system", text: "x" }), ctx)).toEqual([]);
  });

  it("kind=thinking → author_type=thinking", () => {
    const [msg] = projectEvent(frame("thinking", { role: "assistant", preview: "hmm" }), ctx);
    expect(msg.author_type).toBe("thinking");
    expect(msg.content).toBe("hmm");
  });

  it("kind=summary → author_type=summary", () => {
    const [msg] = projectEvent(frame("summary", { text: "recap" }), ctx);
    expect(msg.author_type).toBe("summary");
    expect(msg.content).toBe("recap");
  });

  it("kind=image → author_type=assistant + attachments", () => {
    const [msg] = projectEvent(frame("image", { media_type: "image/png", data: "AAAA" }), ctx);
    expect(msg.author_type).toBe("assistant");
    expect(msg.attachments).toEqual([{ kind: "image", media_type: "image/png", data: "AAAA" }]);
  });

  it("kind=tool-use name=Task → author_type=task, op=create, dedupe_key=task:<id>", () => {
    const [msg] = projectEvent(
      frame("tool-use", {
        name: "Task",
        tool_use_id: "tu-1",
        task: { subagent_type: "Explore", description: "find X", prompt_head: "..." },
      }),
      ctx,
    );
    expect(msg.author_type).toBe("task");
    expect(msg.op).toBe("create");
    expect(msg.dedupe_key).toBe("task:tu-1");
    expect(msg.embeds?.[0]?.fields).toEqual(
      expect.arrayContaining([{ name: "subagent_type", value: "Explore" }]),
    );
  });

  it("kind=tool-result with tool_use_id of a known Task → same dedupe_key, op=update", () => {
    projectEvent(frame("tool-use", { name: "Task", tool_use_id: "tu-1", task: { subagent_type: "Explore", description: "d" } }, 1), ctx);
    const [msg] = projectEvent(frame("tool-result", { tool_use_id: "tu-1", is_error: false, preview: "done" }, 2), ctx);
    expect(msg.op).toBe("update");
    expect(msg.dedupe_key).toBe("task:tu-1");
    expect(msg.author_type).toBe("task");
    expect(msg.content).toBe("done");
  });

  it("kind=tool-use (other) → author_type=tool", () => {
    const [msg] = projectEvent(frame("tool-use", { name: "Bash", tool_use_id: "tu-2", input_preview: "ls" }), ctx);
    expect(msg.author_type).toBe("tool");
    expect(msg.author_label).toBe("Bash");
    expect(msg.dedupe_key).toBe("frame:1");
    expect(msg.content).toBe("実行中");
  });

  it("kind=tool-result (other) updates the prior tool-use with its outcome only", () => {
    projectEvent(frame("tool-use", { name: "Bash", tool_use_id: "tu-2", input_preview: "ls" }, 5), ctx);
    const [msg] = projectEvent(frame("tool-result", { tool_use_id: "tu-2", is_error: false, preview: "out" }, 6), ctx);
    expect(msg.author_type).toBe("tool");
    expect(msg.op).toBe("update");
    expect(msg.dedupe_key).toBe("frame:5");
    expect(msg.content).toBe("成功");
    expect(msg.metadata).toEqual({ tool_use_id: "tu-2", is_error: false, failure: null });
  });

  it("kind=tool-use Skill keeps only its skill name as the label", () => {
    const [msg] = projectEvent(
      frame("tool-use", { name: "Skill", tool_use_id: "tu-3", input_preview: '{"skill":"cc-test"}' }),
      ctx,
    );
    expect(msg.author_label).toBe("Skill: cc-test");
    expect(msg.content).toBe("実行中");
  });

  it("unknown frame kind projects to nothing", () => {
    expect(projectEvent(frame("raw", { type: "session_meta" }), ctx)).toEqual([]);
  });
});

describe("projectEvent / other event types", () => {
  it("session.inject → author_type=user, platform derived from source", () => {
    const ev: ConcordiaEvent = {
      type: "session.inject",
      target_session_id: "s1",
      text: "続けて",
      source: "discord:12345",
      author_label: "neco",
      ts: 500,
    };
    const [msg] = projectEvent(ev, ctx);
    expect(msg.author_type).toBe("user");
    expect(msg.author_label).toBe("neco");
    expect(msg.author_platform).toBe("discord");
    expect(msg.content).toBe("続けて");
    expect(msg.dedupe_key).toBeNull();
    expect(msg.metadata).toBeUndefined();
  });

  it("does not classify platform control injections as human ingress", () => {
    const ev: ConcordiaEvent = {
      type: "session.inject",
      target_session_id: "s1",
      text: "\\n",
      source: "slack-enter-fallback",
      ts: 500,
    };

    const [msg] = projectEvent(ev, ctx);
    expect(msg.author_platform).toBeNull();
  });

  it("question.posted → author_type=question + components", () => {
    const ev: ConcordiaEvent = {
      type: "question.posted",
      target_session_id: "s1",
      question_id: 7,
      question: "どちらにしますか？",
      options: ["A", { label: "B", description: "desc" }],
      ts: 500,
    };
    const [msg] = projectEvent(ev, ctx);
    expect(msg.author_type).toBe("question");
    expect(msg.op).toBe("create");
    expect(msg.dedupe_key).toBe("question:7");
    expect(msg.components?.[0]?.options).toEqual([
      { index: 0, label: "A" },
      { index: 1, label: "B", description: "desc" },
    ]);
  });

  it("question.answered → same dedupe_key, op=update", () => {
    const ev: ConcordiaEvent = {
      type: "question.answered",
      target_session_id: "s1",
      question_id: 7,
      answer_index: 1,
      answer_text: "B",
      ts: 600,
    };
    const [msg] = projectEvent(ev, ctx);
    expect(msg.dedupe_key).toBe("question:7");
    expect(msg.op).toBe("update");
    expect(msg.content).toBeUndefined();
  });

  it("question.resolved → same dedupe_key, op=update", () => {
    const ev: ConcordiaEvent = { type: "question.resolved", target_session_id: "s1", question_id: 7, ts: 700 };
    const [msg] = projectEvent(ev, ctx);
    expect(msg.dedupe_key).toBe("question:7");
    expect(msg.op).toBe("update");
    expect(msg.content).toBeUndefined();
  });

  it("session.permission_request → author_type=permission + components", () => {
    const ev: ConcordiaEvent = {
      type: "session.permission_request",
      target_session_id: "s1",
      request_id: "req-1",
      tool_name: "Bash",
      tool_input: { command: "rm -rf" },
      ts: 800,
    };
    const [msg] = projectEvent(ev, ctx);
    expect(msg.author_type).toBe("permission");
    expect(msg.dedupe_key).toBe("permission:req-1");
    expect(msg.components?.[0]?.kind).toBe("permission_actions");
    expect(msg.metadata).not.toHaveProperty("tool_input");
  });

  it("delegation.mirror → author_type=delegation", () => {
    const ev: ConcordiaEvent = {
      type: "delegation.mirror",
      target_session_id: "s1",
      run_id: "run-1",
      child_session_id: "child-1",
      text: "spawned child",
      ts: 900,
    };
    const [msg] = projectEvent(ev, ctx);
    expect(msg.author_type).toBe("delegation");
    expect(msg.dedupe_key).toBe("delegation:run-1");
  });

  it("operational.claim.opened/released → author_type=system", () => {
    const opened: ConcordiaEvent = {
      type: "operational.claim.opened",
      target_session_id: "s1",
      claim_kind: "test",
      claim_id: 1,
      resource: "Memoria",
      branch: null,
      note: "",
      conflict_session_ids: [],
      started_at: 1,
      ts: 1000,
    };
    const released: ConcordiaEvent = {
      type: "operational.claim.released",
      target_session_id: "s1",
      claim_kind: "test",
      claim_id: 1,
      resource: "Memoria",
      branch: null,
      note: "",
      started_at: 1,
      ts: 1100,
    };
    expect(projectEvent(opened, ctx)[0].author_type).toBe("system");
    expect(projectEvent(opened, ctx)[0].dedupe_key).toBe("claim:1:opened");
    expect(projectEvent(released, ctx)[0].dedupe_key).toBe("claim:1:released");
  });

  it("unrelated event types project to nothing", () => {
    const ev: ConcordiaEvent = { type: "ping", ts: 1 };
    expect(projectEvent(ev, ctx)).toEqual([]);
  });
});

describe("ToolUseDedupeContext", () => {
  it("evicts the oldest entry once the limit is exceeded", () => {
    const small = new ToolUseDedupeContext(2);
    const memo = (dedupeKey: string) => ({ dedupeKey, tool: "Bash", inputPreview: "" });
    small.rememberToolUse("a", memo("frame:1"));
    small.rememberToolUse("b", memo("frame:2"));
    small.rememberToolUse("c", memo("frame:3"));
    expect(small.getToolUse("a")).toBeUndefined();
    expect(small.getToolUse("b")?.dedupeKey).toBe("frame:2");
    expect(small.getToolUse("c")?.dedupeKey).toBe("frame:3");
  });

  it("caps newly retained tool fields even when an opaque frame payload is oversized", () => {
    const small = new ToolUseDedupeContext();
    small.rememberToolUse("a", {
      dedupeKey: "frame:1",
      tool: "t".repeat(1_000),
      inputPreview: "x".repeat(1_000),
    });
    expect(small.getToolUse("a")?.tool.length).toBe(400);
    expect(small.getToolUse("a")?.inputPreview.length).toBe(400);
  });
});

// neco 指示 (2026-09-01): 「Bash 失敗時に Cc の WebUI で何が失敗したか見れるようにしよう」。
// 本文は `失敗` のまま (Discord へ流れる面) で、 内訳は metadata にだけ載せる。
describe("失敗したツール呼び出しの内訳", () => {
  const bashInput = JSON.stringify({ command: "npm run build", description: "build" });

  it("Bash が失敗したらコマンドとエラー出力を metadata に載せる", () => {
    projectEvent(frame("tool-use", { name: "Bash", tool_use_id: "tu-f1", input_preview: bashInput }, 1), ctx);
    const [msg] = projectEvent(
      frame("tool-result", { tool_use_id: "tu-f1", is_error: true, preview: "error TS2554: expected 1 args" }, 2),
      ctx,
    );
    expect(msg.content).toBe("失敗");
    expect(msg.metadata?.failure).toEqual({
      tool: "Bash",
      command: "npm run build",
      error: "error TS2554: expected 1 args",
    });
  });

  it("成功したツールには内訳を付けない (成功分の引数を残さない)", () => {
    projectEvent(frame("tool-use", { name: "Bash", tool_use_id: "tu-f2", input_preview: bashInput }, 3), ctx);
    const [msg] = projectEvent(frame("tool-result", { tool_use_id: "tu-f2", is_error: false, preview: "ok" }, 4), ctx);
    expect(msg.content).toBe("成功");
    expect(msg.metadata?.failure).toBeNull();
  });

  it("対応する tool-use を失っていてもエラー出力だけは残す", () => {
    const [msg] = projectEvent(
      frame("tool-result", { tool_use_id: "tu-unknown", is_error: true, preview: "command not found" }, 5),
      ctx,
    );
    expect(msg.op).toBe("create");
    expect(msg.metadata?.failure).toEqual({ tool: "", command: "", error: "command not found" });
  });

  it("素材が無ければ内訳を付けない (空の詳細で「詳細あり」に見せない)", () => {
    const [msg] = projectEvent(frame("tool-result", { tool_use_id: "tu-empty", is_error: true, preview: "" }, 6), ctx);
    expect(msg.metadata?.is_error).toBe(true);
    expect(msg.metadata?.failure).toBeNull();
  });

  it("失敗した Task にも内訳を付ける", () => {
    projectEvent(
      frame("tool-use", { name: "Task", tool_use_id: "tu-t1", task: { subagent_type: "Explore", description: "d" } }, 7),
      ctx,
    );
    const [msg] = projectEvent(frame("tool-result", { tool_use_id: "tu-t1", is_error: true, preview: "boom" }, 8), ctx);
    expect((msg.metadata?.failure as { error: string }).error).toBe("boom");
  });
});
