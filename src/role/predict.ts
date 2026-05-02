/**
 * Rule-based role 推定. v0.2 で LLM ベースに昇格予定.
 *
 * 戦略:
 *  - tool 比率 (Edit, Bash, Write 等) と file 種別 (test/, src/, infra/, .md 等) を集計
 *  - 主要パターンに合致したらラベル割当. 競合時は score 上位
 *  - 推定の信頼度が低い間は default = "雑用係" (見習い感)
 */

import type { SessionEventRow } from "../shared/types.js";

export interface RoleScore {
  label: string;
  score: number;
}

const PATTERNS: Array<{
  label: string;
  match: (counts: Counts) => number;
}> = [
  {
    label: "テスト魂",
    match: (c) =>
      c.testFileEdits >= 3 ? c.testFileEdits * 1.5 + (c.toolCalls.Bash ?? 0) * 0.2 : 0,
  },
  {
    label: "リファクタ職人",
    match: (c) =>
      c.editEvents >= 5 && c.editsPerFileMax >= 3
        ? c.editEvents + c.editsPerFileMax * 1.2
        : 0,
  },
  {
    label: "インフラ魔導士",
    match: (c) =>
      (c.toolCalls.Bash ?? 0) >= 6 || c.infraFileEdits >= 3
        ? (c.toolCalls.Bash ?? 0) * 0.8 + c.infraFileEdits * 1.5
        : 0,
  },
  {
    label: "アーキテクト先生",
    match: (c) =>
      c.specFileEdits >= 2 || c.compactCount >= 2
        ? c.specFileEdits * 2 + c.compactCount * 1.5
        : 0,
  },
  {
    label: "深掘り型",
    match: (c) =>
      c.compactCount >= 3 ? c.compactCount * 2 + (c.promptCount > 30 ? 5 : 0) : 0,
  },
  {
    label: "スピード狂",
    match: (c) =>
      c.editEvents >= 10 && c.compactCount === 0 ? c.editEvents * 0.6 : 0,
  },
  {
    label: "規約警察",
    match: (c) =>
      (c.toolCalls.lint ?? 0) + (c.toolCalls.format ?? 0) >= 2
        ? ((c.toolCalls.lint ?? 0) + (c.toolCalls.format ?? 0)) * 2
        : 0,
  },
  {
    label: "スケッチ屋",
    match: (c) =>
      c.specFileEdits >= 1 && c.editEvents <= 3
        ? c.specFileEdits * 1.5 + 2
        : 0,
  },
];

interface Counts {
  promptCount: number;
  editEvents: number;
  compactCount: number;
  testFileEdits: number;
  infraFileEdits: number;
  specFileEdits: number;
  editsPerFileMax: number;
  toolCalls: Record<string, number>;
}

export function predictRole(events: SessionEventRow[]): string {
  const c: Counts = {
    promptCount: 0,
    editEvents: 0,
    compactCount: 0,
    testFileEdits: 0,
    infraFileEdits: 0,
    specFileEdits: 0,
    editsPerFileMax: 0,
    toolCalls: {},
  };
  const filesEdited = new Map<string, number>();

  for (const ev of events) {
    if (ev.kind === "prompt") c.promptCount++;
    if (ev.kind === "compact") c.compactCount++;
    if (ev.kind === "edit") {
      c.editEvents++;
      const payload = safeParse(ev.payload);
      const file: string = payload?.file ?? "";
      if (file) {
        filesEdited.set(file, (filesEdited.get(file) ?? 0) + 1);
        if (/(^|\/)tests?\//i.test(file) || /\.test\.[a-z]+$/i.test(file)) c.testFileEdits++;
        if (/(^|\/)(infra|deploy|docker|k8s|ops)\//i.test(file)) c.infraFileEdits++;
        if (/(^|\/)spec\//i.test(file) || /\.md$/i.test(file)) c.specFileEdits++;
      }
    }
    if (ev.kind === "tool_call") {
      const payload = safeParse(ev.payload);
      const name: string = payload?.tool ?? "";
      if (name) c.toolCalls[name] = (c.toolCalls[name] ?? 0) + 1;
    }
  }
  for (const v of filesEdited.values()) {
    if (v > c.editsPerFileMax) c.editsPerFileMax = v;
  }

  const scored: RoleScore[] = PATTERNS.map((p) => ({ label: p.label, score: p.match(c) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.label ?? "雑用係";
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}
