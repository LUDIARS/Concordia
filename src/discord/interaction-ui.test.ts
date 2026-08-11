import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPanel, decodePanelId, encodePanelId, panelEmbedJson } from "./interaction-ui.js";
import {
  buildPrOperationPanel,
  buildPrSubmitResultPanel,
  parsePrPanelId,
  PR_PANEL_NAMESPACE,
} from "./pr-panel.js";
import {
  buildRwfAckPanel,
  buildRwfActionSelectPanel,
  buildRwfResultPanel,
  parseRwfPanelId,
  RWF_PANEL_NAMESPACE,
} from "./rwf-panel.js";

describe("buildPanel", () => {
  it("renders an embed with fields, a select row and a button row", () => {
    const panel = buildPanel({
      title: "タイトル",
      description: "説明",
      tone: "success",
      fields: [{ name: "A", value: "1", inline: true }],
      selects: [{ customId: "ns:pick", placeholder: "選ぶ", options: [{ value: "v", label: "L" }] }],
      buttons: [{ customId: "ns:go", label: "実行", style: "primary" }],
    });

    const [embed] = panelEmbedJson(panel);
    expect(embed.title).toBe("タイトル");
    expect(embed.description).toBe("説明");
    expect(embed.fields).toHaveLength(1);
    expect(panel.components).toHaveLength(2);

    const rows = panel.components.map((row) => row.toJSON());
    expect(rows[0].components[0]).toMatchObject({ custom_id: "ns:pick", placeholder: "選ぶ" });
    expect(rows[1].components[0]).toMatchObject({ custom_id: "ns:go", label: "実行" });
  });

  it("wraps buttons into rows of five", () => {
    const buttons = Array.from({ length: 7 }, (_, i) => ({
      customId: `ns:b${i}`,
      label: `b${i}`,
      style: "secondary" as const,
    }));
    const panel = buildPanel({ title: "t", buttons });
    expect(panel.components.map((row) => row.toJSON().components.length)).toEqual([5, 2]);
  });

  it("says in the footer when a select has no options (never silently empty)", () => {
    const panel = buildPanel({
      title: "t",
      selects: [{ customId: "ns:pick", placeholder: "マージする PR", options: [] }],
    });
    expect(panel.components).toHaveLength(0);
    expect(panelEmbedJson(panel)[0].footer?.text).toContain("選択肢が無いため");
  });

  it("says in the footer when select options are truncated to the Discord limit", () => {
    const options = Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, label: `l${i}` }));
    const panel = buildPanel({ title: "t", selects: [{ customId: "ns:pick", placeholder: "p", options }] });

    expect(panel.components[0].toJSON().components[0]).toMatchObject({ custom_id: "ns:pick" });
    expect(panelEmbedJson(panel)[0].footer?.text).toContain("5 件を省略");
  });
});

describe("panel customId codec", () => {
  it("round-trips namespace, action and params", () => {
    const id = encodePanelId("ns", "act", "p1", "p2");
    expect(decodePanelId(id, "ns")).toEqual({ action: "act", params: ["p1", "p2"] });
  });

  it("ignores customIds of other surfaces", () => {
    expect(decodePanelId("other:act", "ns")).toBeNull();
    expect(decodePanelId("ns", "ns")).toBeNull();
  });

  it("refuses to build an ambiguous id", () => {
    expect(() => encodePanelId("ns", "act", "a:b")).toThrow(/must not contain/);
  });
});

describe("PR operation panel", () => {
  const state = {
    sessionId: "sess-1",
    branch: "feat/x",
    repository: "LUDIARS/Concordia",
    openPullRequests: [{ id: "lpr-1", number: 7, repository: "LUDIARS/Concordia", headRef: "feat/x" }],
  };

  it("offers submit / merge buttons and a target select", () => {
    const panel = buildPrOperationPanel(state);
    const customId = (row: number, index: number): string =>
      (panel.components[row].toJSON().components[index] as { custom_id?: string }).custom_id ?? "";

    expect(parsePrPanelId(customId(0, 0))).toEqual({ action: "select", sessionId: "sess-1" });
    expect(parsePrPanelId(customId(1, 0))).toEqual({ action: "submit", sessionId: "sess-1" });
    expect(parsePrPanelId(customId(1, 1))).toEqual({ action: "merge", sessionId: "sess-1" });
  });

  it("shows the submission outcome text in the same panel", () => {
    const panel = buildPrSubmitResultPanel(
      state,
      { ok: false, kind: "skipped", reason: "no_commits" },
      { userId: "u-1" },
    );
    expect(panelEmbedJson(panel)[0].description).toContain("コミットがありません");
  });

  it("does not claim a merge target when there is none", () => {
    const panel = buildPrOperationPanel({ ...state, openPullRequests: [] });
    const embed = panelEmbedJson(panel)[0];
    expect(embed.fields?.some((f) => f.value === "(なし)")).toBe(true);
    expect(embed.footer?.text).toContain("選択肢が無いため");
  });
});

describe("RWF panels", () => {
  it("lists workflow actions in a select menu", () => {
    const panel = buildRwfActionSelectPanel({ targetMessageId: "m-1" });
    const row = panel.components[0].toJSON();
    const menu = row.components[0] as { custom_id?: string; options?: Array<{ value: string }> };

    expect(parseRwfPanelId(menu.custom_id!)).toEqual({ action: "choose", targetMessageId: "m-1" });
    expect(menu.options?.map((o) => o.value)).toContain("submit-pr");
    expect(menu.options?.map((o) => o.value)).toContain("merge-pr");
  });

  it("renders the acknowledgement with the action label and actor", () => {
    const panel = buildRwfAckPanel({ action: "submit-pr", emoji: "📮", targetMessageId: "m-1", actorId: "u-1" });
    const embed = panelEmbedJson(panel)[0];

    expect(embed.title).toContain("📮");
    expect(embed.title).toContain("PR を提出する");
    expect(embed.fields?.some((f) => f.value === "<@u-1>")).toBe(true);
  });

  it("colors the result panel by outcome", () => {
    const ok = panelEmbedJson(buildRwfResultPanel({ action: "merge-pr", ok: true, text: "done", targetMessageId: "m" }))[0];
    const ng = panelEmbedJson(buildRwfResultPanel({ action: "merge-pr", ok: false, text: "no", targetMessageId: "m" }))[0];
    expect(ok.color).not.toBe(ng.color);
  });
});

/**
 * W4 の核心: 操作面ごとに描画コードを書かない。 両操作面が共通部品 (interaction-ui) を
 * 通っていること、 embed / ActionRow を自前で組んでいないことをソースで固定する。
 */
describe("shared UI component usage", () => {
  const surfaces = ["pr-panel.ts", "rwf-panel.ts"];
  const read = (name: string): string => readFileSync(join(process.cwd(), "src", "discord", name), "utf-8");

  it.each(surfaces)("%s builds its screen through interaction-ui", (name) => {
    const source = read(name);
    expect(source).toContain('from "./interaction-ui.js"');
    expect(source).toContain("buildPanel(");
  });

  it.each(surfaces)("%s does not hand-build embeds or action rows", (name) => {
    const source = read(name);
    expect(source).not.toMatch(/new EmbedBuilder\(/);
    expect(source).not.toMatch(/new ActionRowBuilder/);
    expect(source).not.toMatch(/new (Button|StringSelectMenu)Builder/);
  });

  it("keeps the two surfaces on distinct customId namespaces", () => {
    expect(PR_PANEL_NAMESPACE).not.toBe(RWF_PANEL_NAMESPACE);
    expect(parseRwfPanelId(`${PR_PANEL_NAMESPACE}:submit:s1`)).toBeNull();
    expect(parsePrPanelId(`${RWF_PANEL_NAMESPACE}:choose:m1`)).toBeNull();
  });
});
