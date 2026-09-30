/**
 * 起動要求 (`/v1/admin/spawn-session` の body) から事前ヒアリングを読む境界。
 *
 * `consultation_intake` は受付 (部署フォーラム / `/consult` のモーダル) が揃えた 4 項目。
 * 形が不正なら「無し」として扱い、 起動そのものは止めない (前提が欠けるだけで、
 * 受付側が必須項目を揃えてから起動する — tech-consultation.md §3)。
 *
 * @implements SPEC-CONSULT-INTAKE
 */

import { z } from "zod";
import type { ConsultIntakeSource } from "../db/consultation-intakes-repo.js";
import { MAX_CONSULT_INTAKE_FIELD_CHARS, normalizeConsultIntake, type ConsultIntake } from "./intake.js";

const FieldSchema = z.string().max(MAX_CONSULT_INTAKE_FIELD_CHARS * 2).optional();

const IntakeRequestSchema = z.object({
  topic: FieldSchema,
  skill_level: FieldSchema,
  role_title: FieldSchema,
  purpose: FieldSchema,
  source: z.enum(["forum", "modal", "api"]).default("api"),
}).strict();

export interface ConsultIntakeRequest {
  values: ConsultIntake;
  source: ConsultIntakeSource;
  /** 受付のチャンネル (フォーラムのスレッド / プライベート相談のチャンネル)。 */
  channelId: string | null;
}

export function readConsultIntakeRequest(body: Record<string, unknown>): ConsultIntakeRequest | null {
  if (body.consultation_intake === undefined || body.consultation_intake === null) return null;
  const parsed = IntakeRequestSchema.safeParse(body.consultation_intake);
  if (!parsed.success) return null;
  const { source, ...fields } = parsed.data;
  const channel = typeof body.source_discord_channel_id === "string" ? body.source_discord_channel_id.trim() : "";
  return {
    values: normalizeConsultIntake(fields),
    source,
    channelId: /^\d{5,32}$/.test(channel) ? channel : null,
  };
}
