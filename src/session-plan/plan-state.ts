/**
 * セッションの作業のプラン (update_plan / wrap_up) を、 セッションごとの状態として持つ
 * (spec/feature/session-plan-discord.md)。 送り手 (デスクトップの Claude アプリの hook・agy と Grok の CLI) に依らない。
 *
 * プラン更新は差分で届く (全体の置き換え / 次へ進める / 番号で完了・開始)。 ここで直前の状態に当てて
 * プラン全体を組み立て直す。 純関数のみ。 保存・投稿は呼び出し側。
 *
 * @implements SPEC-SESSION-PLAN-DISCORD
 */

import { z } from "zod";

/** 保存先の metadata のキー。 デスクトップ版から始まった名前を互換のため据え置く。 */
export const SESSION_PLAN_METADATA_KEY = "desktop_plan";
/** プラン更新のイベントの kind (hook・CLI 共通)。 互換のため据え置く。 */
export const SESSION_PLAN_EVENT_KIND = "desktop_plan";

const MAX_STEPS = 12;
const stepStatus = z.enum(["pending", "in_progress", "completed"]);
const stepSchema = z.object({ content: z.string().trim().min(1).max(400), status: stepStatus });

const updatePlanInput = z.object({
  items: z.array(stepSchema.passthrough()).max(MAX_STEPS).optional(),
  advance: z.boolean().optional(),
  done: z.array(z.number().int().positive()).max(MAX_STEPS).optional(),
  start: z.number().int().positive().optional(),
}).passthrough();

const wrapUpInput = z.object({
  recap: z.string().trim().min(1).max(2000),
  ask: z.string().trim().max(400).optional(),
  actions: z.array(z.object({ label: z.string().optional(), action: z.string().optional() }).passthrough()).max(4).optional(),
  blocked: z.boolean().optional(),
}).passthrough();

const planCallSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("update_plan"), input: updatePlanInput }),
  z.object({ tool: z.literal("wrap_up"), input: wrapUpInput }),
]);

const summarySchema = z.object({
  recap: z.string(),
  ask: z.string().nullable(),
  choices: z.array(z.string()),
  blocked: z.boolean(),
});

const planStateSchema = z.object({
  steps: z.array(stepSchema).max(MAX_STEPS),
  /** working = 作業中、 summary = サマリを出して終えた、 waiting = サマリを出して人の回答を待っている。 */
  phase: z.enum(["working", "summary", "waiting"]),
  summary: summarySchema.nullable(),
  updated_at: z.number(),
});

export type SessionPlanStep = z.infer<typeof stepSchema>;
export type SessionPlanCall = z.infer<typeof planCallSchema>;
export type SessionPlanState = z.infer<typeof planStateSchema>;

/** hook のイベントの payload を読む。 形が違えば null。 */
export function parseSessionPlanCall(payload: unknown): SessionPlanCall | null {
  const parsed = planCallSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/** セッションの metadata (JSON 文字列) から保存済みのプランを読む。 無い・壊れているなら null。 */
export function readSessionPlan(metadata: string | null): SessionPlanState | null {
  if (!metadata) return null;
  try {
    const parsed = planStateSchema.safeParse((JSON.parse(metadata) as Record<string, unknown>)[SESSION_PLAN_METADATA_KEY]);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function advance(steps: SessionPlanStep[]): void {
  const current = steps.findIndex((step) => step.status === "in_progress");
  if (current >= 0) steps[current] = { ...steps[current]!, status: "completed" };
  const next = steps.findIndex((step) => step.status === "pending");
  if (next >= 0) steps[next] = { ...steps[next]!, status: "in_progress" };
}

function applyUpdate(previous: SessionPlanStep[], input: z.infer<typeof updatePlanInput>): SessionPlanStep[] {
  const steps = input.items
    ? input.items.map((item) => ({ content: item.content, status: item.status }))
    : previous.map((step) => ({ ...step }));
  if (input.advance) advance(steps);
  // 番号は 1 始まり。 範囲外は無視する。
  for (const number of input.done ?? []) {
    const step = steps[number - 1];
    if (step) steps[number - 1] = { ...step, status: "completed" };
  }
  const started = input.start === undefined ? undefined : steps[input.start - 1];
  if (started && input.start !== undefined) steps[input.start - 1] = { ...started, status: "in_progress" };
  return steps;
}

/** プランの呼び出し 1 回を直前の状態に当てて、 次の状態を返す。 */
export function applySessionPlanCall(previous: SessionPlanState | null, call: SessionPlanCall, nowSec: number): SessionPlanState {
  if (call.tool === "update_plan") {
    return { steps: applyUpdate(previous?.steps ?? [], call.input), phase: "working", summary: null, updated_at: nowSec };
  }
  // wrap_up はタスクのリストを全部済みにして閉じる (アプリの表示と同じ)。
  const choices = (call.input.actions ?? [])
    .map((action) => (action.label ?? action.action ?? "").trim())
    .filter((label) => label.length > 0);
  return {
    steps: (previous?.steps ?? []).map((step) => ({ ...step, status: "completed" as const })),
    phase: call.input.blocked ? "waiting" : "summary",
    summary: { recap: call.input.recap, ask: call.input.ask?.trim() || null, choices, blocked: call.input.blocked ?? false },
    updated_at: nowSec,
  };
}
