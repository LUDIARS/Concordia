import { describe, it, expect } from "vitest";
import {
  buildContextWarningMessage,
  buildSessionStatusEmbed,
  type StatusEmbedInput,
} from "./session-status-card.js";

function base(overrides: Partial<StatusEmbedInput> = {}): StatusEmbedInput {
  return {
    sessionId: "lictor-abc123def456",
    provider: "claude-code",
    model: "claude-opus-4-8",
    effortLevel: "high",
    fastMode: true,
    branch: "feat/x",
    repoPath: "E:/Document/Ars/Concordia",
    currentTask: null,
    status: "active",
    ageSec: 10,
    roleLabel: "アーキテクト先生",
    sessionChannelId: "999",
    inProgress: [],
    pending: [],
    doneCount: 0,
    concordiaPending: 0,
    ...overrides,
  };
}

function field(embed: ReturnType<typeof buildSessionStatusEmbed>, name: string) {
  return embed.data.fields?.find((f) => f.name.startsWith(name));
}

const MOJIBAKE_RE = /(?:繧|縺|蠢|笞|譁|荳|蜷|邯|蝙|玄|貞|鬆|譛|謚)/;

describe("buildSessionStatusEmbed", () => {
  it("active かつ直近イベントなら緑、 ended ならグレー", () => {
    expect(buildSessionStatusEmbed(base({ status: "active", ageSec: 5 })).data.color).toBe(0x3ba55d);
    expect(buildSessionStatusEmbed(base({ status: "active", ageSec: 120 })).data.color).toBe(0xfaa61a);
    expect(buildSessionStatusEmbed(base({ status: "ended", ageSec: null })).data.color).toBe(0x747f8d);
  });

  it("状態ラベルは文字化けせず日本語で表示する", () => {
    const active = field(buildSessionStatusEmbed(base({ status: "active", ageSec: 5 })), "状態")!.value;
    expect(active).toContain("🟢 作業中");
    expect(active).not.toMatch(MOJIBAKE_RE);

    const waiting = field(buildSessionStatusEmbed(base({ status: "active", ageSec: 120 })), "状態")!.value;
    expect(waiting).toContain("🟡 待機");
    expect(waiting).not.toMatch(MOJIBAKE_RE);

    const idle = field(buildSessionStatusEmbed(base({ status: "active", ageSec: null })), "状態")!.value;
    expect(idle).toContain("⚪ アイドル");
    expect(idle).not.toMatch(MOJIBAKE_RE);
  });

  it("title は roleLabel、 無しは provider にフォールバック", () => {
    expect(buildSessionStatusEmbed(base()).data.title).toBe("アーキテクト先生");
    expect(buildSessionStatusEmbed(base({ roleLabel: null })).data.title).toBe("claude-code");
  });

  it("Repo field はフルパスでなくリポ名、 footer にフルパス", () => {
    const e = buildSessionStatusEmbed(base());
    expect(field(e, "Repo")?.value).toBe("`Concordia`");
    expect(e.data.footer?.text).toContain("E:/Document/Ars/Concordia");
    expect(e.data.footer?.text).toContain("session abc123de"); // lictor- 除去 + 8 桁
  });

  it("runtimeと非root作業ブランチを明示する", () => {
    const e = buildSessionStatusEmbed(base());
    expect(field(e, "作業ブランチ")?.value).toBe("🟠 non-root `feat/x`");
    expect(field(e, "Model")?.value).toBe("`claude-opus-4-8`");
    expect(field(e, "Effort")?.value).toBe("`high`");
    expect(field(e, "Fast mode")?.value).toBe("⚡ ON");

    const root = buildSessionStatusEmbed(base({ branch: "main", fastMode: false }));
    expect(field(root, "作業ブランチ")?.value).toBe("root `main`");
    expect(field(root, "Fast mode")?.value).toBe("OFF");
  });

  it("current task は description に太字 + チャンネルメンション", () => {
    const e = buildSessionStatusEmbed(base({ currentTask: "状態カードを整理", sessionChannelId: "42" }));
    expect(e.data.description).toContain("**状態カードを整理**");
    expect(e.data.description).toContain("<#42>");
  });

  it("タスク見出しはカウント、 依頼残>0 のときだけ付く", () => {
    const noPending = buildSessionStatusEmbed(base({
      inProgress: [{ active_form: "実装中", task_text: "t1" }],
      pending: [{ task_text: "t2" }, { task_text: "t3" }],
      doneCount: 4,
    }));
    const h = field(noPending, "タスク")!;
    expect(h.name).toContain("1 ▶ / 2 ⏳ / 4 ✓");
    expect(h.name).not.toContain("依頼残");
    expect(h.value).toContain("▶ 実装中");
    expect(h.value).toContain("⏳ t2");

    const withPending = buildSessionStatusEmbed(base({ concordiaPending: 3 }));
    expect(field(withPending, "タスク")!.name).toContain("依頼残 3");
    expect(field(withPending, "タスク")!.value).toContain("no open tasks");
  });

  it("queued/running/completed/failed の child Delegation を task と child identity 付きで表示する", () => {
    const e = buildSessionStatusEmbed(base({
      delegatedChildren: [
        { runId: "run-queued-123", callName: "design", taskLabel: "設計する", childSessionId: null, status: "queued" },
        { runId: "run-running-1", callName: "impl", taskLabel: "実装する", childSessionId: "lictor-childabc123", status: "running" },
        { runId: "run-complete1", callName: "review", taskLabel: "レビューする", childSessionId: "lictor-done123456", status: "completed" },
        { runId: "run-failed-12", callName: "verify", taskLabel: "検証する", childSessionId: "lictor-fail123456", status: "failed" },
      ],
    }));
    const children = field(e, "Delegation children")!;
    expect(children.name).toBe("Delegation children (4)");
    expect(children.value).toContain("`queued` 設計する · design · run run-queu");
    expect(children.value).toContain("`running` 実装する · impl · run run-runn · child childabc");
    expect(children.value).toContain("`completed` レビューする");
    expect(children.value).toContain("`failed` 検証する");
  });

  it("Delegation children field を Discord の1024文字上限内に収める", () => {
    const delegatedChildren = Array.from({ length: 8 }, (_, index) => ({
      runId: `run-${index}-${"r".repeat(60)}`,
      callName: `call-${index}-${"c".repeat(60)}`,
      taskLabel: `task-${index}-${"日".repeat(200)}`,
      childSessionId: `lictor-child-${index}-${"s".repeat(40)}`,
      status: "running",
    }));
    const value = field(buildSessionStatusEmbed(base({ delegatedChildren })), "Delegation children")!.value;
    expect(value.length).toBeLessThanOrEqual(1024);
  });

  it("コンテキスト占有と想定コストを description に 1 行で出す", () => {
    const e = buildSessionStatusEmbed(base({
      contextBadge: "🧠 ctx ~62% (124k)",
      contextPct: 0.62,
      costBadge: "💰 ~$1.23",
    }));
    expect(e.data.description).toContain("🧠 ctx ~62% (124k) · 💰 ~$1.23");
    // 閾値超え (>=0.75) は ⚠️ を添える
    const warn = buildSessionStatusEmbed(base({
      contextBadge: "🧠 ctx ~80% (160k)",
      contextPct: 0.8,
      costBadge: "💰 ~$2.50",
    }));
    expect(warn.data.description).toContain("⚠️ 🧠 ctx ~80% (160k) · 💰 ~$2.50");
    // どちらも無ければ usage 行は出ない
    expect(buildSessionStatusEmbed(base()).data.description).not.toContain("💰");
  });

  it("Anatomia キャッシュ field は cache があるときだけ出る (assumed は ~ 付き)", () => {
    const none = buildSessionStatusEmbed(base());
    expect(field(none, "Anatomia")).toBeUndefined();

    const withCache = buildSessionStatusEmbed(base({
      cache: { hits: 8, gets: 12, hitRate: 8 / 12, savedUsd: 0.14, spentUsd: 0.07, basis: "assumed" },
    }));
    const f = field(withCache, "Anatomia")!;
    expect(f.value).toContain("67% hit (8/12)");
    expect(f.value).toContain("節約 ~$0.14");
    expect(f.value).toContain("コスト ~$0.07");

    // measured basis は ~ なし、gets=0 は省略
    const measured = buildSessionStatusEmbed(base({
      cache: { hits: 2, gets: 10, hitRate: 0.2, savedUsd: 0.035, spentUsd: 0.14, basis: "measured" },
    }));
    expect(field(measured, "Anatomia")!.value).toContain("20% hit (2/10) · 節約 $0.0350 · コスト $0.14");
    expect(field(buildSessionStatusEmbed(base({ cache: { hits: 0, gets: 0, hitRate: 0, savedUsd: 0, spentUsd: 0, basis: "assumed" } })), "Anatomia")).toBeUndefined();
  });

  it("85% 超過通知は依頼者メンションと具体的な圧縮案を含む", () => {
    const msg = buildContextWarningMessage({
      sessionId: "lictor-abc123",
      contextBadge: "🧠 ctx ~86% (172k)",
      contextPct: 0.86,
      requesterUserId: "1234567890",
    });
    expect(msg).toContain("<@1234567890>");
    expect(msg).toContain("⚠️ コンテキスト使用量が 86% を超えました");
    expect(msg).toContain("必要なら");
    expect(msg).toContain("引き継ぎ型コンパクション");
    expect(msg).toContain("86%");
    expect(msg).toContain("/co-compaction");
    expect(msg).not.toMatch(MOJIBAKE_RE);
  });
});
