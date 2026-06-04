import { describe, it, expect } from "vitest";
import { buildSessionStatusEmbed, type StatusEmbedInput } from "./session-status-card.js";

function base(overrides: Partial<StatusEmbedInput> = {}): StatusEmbedInput {
  return {
    sessionId: "lictor-abc123def456",
    provider: "claude-code",
    branch: "feat/x",
    repoPath: "E:/Document/Ars/Concordia",
    currentTask: null,
    status: "active",
    ageSec: 10,
    personaText: "アーキテクト先生 / 構橋 慧",
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

describe("buildSessionStatusEmbed", () => {
  it("active かつ直近イベントなら緑、 ended ならグレー", () => {
    expect(buildSessionStatusEmbed(base({ status: "active", ageSec: 5 })).data.color).toBe(0x3ba55d);
    expect(buildSessionStatusEmbed(base({ status: "active", ageSec: 120 })).data.color).toBe(0xfaa61a);
    expect(buildSessionStatusEmbed(base({ status: "ended", ageSec: null })).data.color).toBe(0x747f8d);
  });

  it("title は persona、 persona 無しは provider にフォールバック", () => {
    expect(buildSessionStatusEmbed(base()).data.title).toBe("アーキテクト先生 / 構橋 慧");
    expect(buildSessionStatusEmbed(base({ personaText: "-" })).data.title).toBe("claude-code");
  });

  it("Repo field はフルパスでなくリポ名、 footer にフルパス", () => {
    const e = buildSessionStatusEmbed(base());
    expect(field(e, "Repo")?.value).toBe("`Concordia`");
    expect(e.data.footer?.text).toContain("E:/Document/Ars/Concordia");
    expect(e.data.footer?.text).toContain("session abc123de"); // lictor- 除去 + 8 桁
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
});
