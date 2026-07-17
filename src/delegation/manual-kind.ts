/**
 * delegation テンプレ → Inject マニュアル kind の解決 (純関数)。
 * call_name / title の簡易ヒューリスティックで判定する。
 * kind 語彙 = spec/feature/task-workflow.md §2.1 (設計相談 | 実装 | レビュー | テスト | 雑用)。
 *
 * 優先順位:
 * 1. 実装系キーワード (impl / fix / refactor / employee / 実装) — 「impl-from-design」や
 *    「daily-review-autofix」のようにコード変更 + PR を行うテンプレが design/review を含んでも
 *    実装マニュアル (worktree 生成 → PR) を受け取れるように最優先。
 * 2. review / レビュー → レビュー
 * 3. design / 設計 → 設計相談
 * 4. test / テスト → テスト
 * 5. 既定 → 実装 (「雑用」への自動マッピングは持たない)
 */

import type { InjectManualKind } from "../db/inject-manuals-repo.js";

export interface ManualKindSource {
  call_name: string;
  title: string;
}

const IMPL_HINTS = ["impl", "fix", "refactor", "employee", "実装"];

export function resolveManualKind(template: ManualKindSource): InjectManualKind {
  const haystack = `${template.call_name} ${template.title}`.toLowerCase();
  if (IMPL_HINTS.some((hint) => haystack.includes(hint))) return "実装";
  if (haystack.includes("review") || haystack.includes("レビュー")) return "レビュー";
  if (haystack.includes("design") || haystack.includes("設計")) return "設計相談";
  if (haystack.includes("test") || haystack.includes("テスト")) return "テスト";
  return "実装";
}
