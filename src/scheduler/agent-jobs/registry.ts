/**
 * 外部エージェントへ回せる定時ジョブの一覧と組み立て。
 * ここに無いジョブ (data builder の無いジョブ) は宛先を外部エージェントにできない (CC-PT-AGENT-INV-06)。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 対応ジョブ
 */

import { AI_NOTE_BIWEEKLY_REVIEW_JOB, createAiNoteBiweeklyReviewJob, type AiNoteSources } from "./ai-note-biweekly-review.js";
import { createDepsSweepDailyJob, DEPS_SWEEP_DAILY_JOB, type DepsSweepSources } from "./deps-sweep-daily.js";
import { createKaizenDailyJob, KAIZEN_DAILY_JOB, type KaizenSources } from "./kaizen-daily.js";
import { createLudiarsReviewWeeklyJob, LUDIARS_REVIEW_WEEKLY_JOB, type ReviewWeeklySources } from "./ludiars-review-weekly.js";
import { createLudiarsStatusDailyJob, LUDIARS_STATUS_DAILY_JOB, type LudiarsStatusSources } from "./ludiars-status-daily.js";
import { createQuaestorMailSweepJob, QUAESTOR_MAIL_SWEEP_JOB, type MailSweepSources } from "./quaestor-mail-sweep.js";
import type { AgentJobSpec } from "./types.js";

/** 外部エージェントへ切り替えられるジョブ名。 設定の保存時の判定はこれだけを見る (読み取り元が無くても判定できる)。 */
export const AGENT_JOB_NAMES: readonly string[] = [
  LUDIARS_STATUS_DAILY_JOB,
  LUDIARS_REVIEW_WEEKLY_JOB,
  AI_NOTE_BIWEEKLY_REVIEW_JOB,
  DEPS_SWEEP_DAILY_JOB,
  KAIZEN_DAILY_JOB,
  QUAESTOR_MAIL_SWEEP_JOB,
];

export function hasAgentJob(jobName: string): boolean {
  return AGENT_JOB_NAMES.includes(jobName);
}

export type AgentJobSources = LudiarsStatusSources & ReviewWeeklySources & AiNoteSources & DepsSweepSources & KaizenSources & MailSweepSources;

export interface AgentJobRegistry {
  get(jobName: string): AgentJobSpec | null;
}

export function createAgentJobRegistry(sources: AgentJobSources): AgentJobRegistry {
  const specs = new Map<string, AgentJobSpec>([
    createLudiarsStatusDailyJob(sources),
    createLudiarsReviewWeeklyJob(sources),
    createAiNoteBiweeklyReviewJob(sources),
    createDepsSweepDailyJob(sources),
    createKaizenDailyJob(sources),
    createQuaestorMailSweepJob(sources),
  ].map((spec) => [spec.jobName, spec]));
  return { get: (jobName) => specs.get(jobName) ?? null };
}
