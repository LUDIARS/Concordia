/**
 * delegation テンプレ → Inject マニュアル kind の解決 (純関数)。
 * kind 語彙 = spec/feature/task-workflow.md §2.1 (設計相談 | 実装 | レビュー | テスト | 雑用)。
 *
 * 優先順位:
 * 0. category = "parttimer" → 雑用。 時間で起動する定時作業は実装とは別の作法で回る
 *    (worktree / PR / 完了条件チェックリストを持たない)。 call_name / title の語で
 *    実装マニュアルへ落ちると、 読み取りだけのタスクにも PR 提出が要求されて詰む
 *    (2026-09-03 neco 指示。 経緯は delegation/parttimer-inject.ts 冒頭)。
 * 1. 実装系キーワード (impl / fix / refactor / employee / 実装) — 「impl-from-design」や
 *    「daily-review-autofix」のようにコード変更 + PR を行うテンプレが design/review を含んでも
 *    実装マニュアル (worktree 生成 → PR) を受け取れるように最優先。
 * 2. review / レビュー → レビュー
 * 3. design / 設計 → 設計相談
 * 4. test / テスト → テスト
 * 5. 既定 → 実装 (「雑用」への自動マッピングは category からのみ)
 */

import type { DelegationCategory } from "../db/delegation-repo.js";
import type { InjectManualKind } from "../db/inject-manuals-repo.js";

export interface ManualKindSource {
  call_name: string;
  title: string;
  /** 雇用形態カテゴリ。 未指定は employee 相当として語のヒューリスティックへ回す。 */
  category?: DelegationCategory | null;
}

const IMPL_HINTS = ["impl", "fix", "refactor", "employee", "実装"];

export function resolveManualKind(template: ManualKindSource): InjectManualKind {
  if (template.category === "parttimer") return "雑用";
  const haystack = `${template.call_name} ${template.title}`.toLowerCase();
  if (IMPL_HINTS.some((hint) => haystack.includes(hint))) return "実装";
  if (haystack.includes("review") || haystack.includes("レビュー")) return "レビュー";
  if (haystack.includes("design") || haystack.includes("設計")) return "設計相談";
  if (haystack.includes("test") || haystack.includes("テスト")) return "テスト";
  return "実装";
}
