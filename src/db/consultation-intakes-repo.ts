/**
 * 相談ごとの事前ヒアリング (consultation_intakes) の repository。 保存と照会だけを持つ。
 *
 * 起動前に集めるので session id ではなく受付のチャンネル (フォーラムのスレッド /
 * プライベート相談のチャンネル) で辿る。 値は依頼者メモと同じくローカル DB にだけ置き、
 * ログへ出さない (CC-CONSULT-INV-05)。
 *
 * @implements SPEC-CONSULT-INTAKE
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ConsultIntake } from "../dialogue/intake.js";
import type { RequesterPlatform } from "./requester-profiles-repo.js";

export type ConsultIntakeSource = "forum" | "modal" | "api";

export interface ConsultationIntakeRow extends ConsultIntake {
  id: string;
  subsidiary_id: string | null;
  department_id: string;
  use_case_id: string | null;
  platform: RequesterPlatform;
  platform_user_id: string;
  channel_id: string | null;
  source: ConsultIntakeSource;
  created_at: number;
}

export interface ConsultationIntakeInput extends ConsultIntake {
  subsidiary_id: string | null;
  department_id: string;
  use_case_id: string | null;
  platform: RequesterPlatform;
  platform_user_id: string;
  channel_id: string | null;
  source: ConsultIntakeSource;
}

export class ConsultationIntakesRepo {
  constructor(private readonly db: Database.Database) {}

  record(input: ConsultationIntakeInput, now: number = Date.now()): ConsultationIntakeRow {
    const id = `ci_${randomUUID().replace(/-/g, "")}`;
    this.db.prepare(`
      INSERT INTO consultation_intakes(id, subsidiary_id, department_id, use_case_id, platform, platform_user_id,
        channel_id, source, topic, skill_level, role_title, purpose, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.subsidiary_id, input.department_id, input.use_case_id, input.platform, input.platform_user_id,
      input.channel_id, input.source, input.topic, input.skill_level, input.role_title, input.purpose, now,
    );
    return this.find(id)!;
  }

  find(id: string): ConsultationIntakeRow | null {
    return (this.db.prepare("SELECT * FROM consultation_intakes WHERE id = ?").get(id) as ConsultationIntakeRow | undefined)
      ?? null;
  }

  /** 受付チャンネルの最新のヒアリング (公開候補の題名などに使う)。 */
  latestForChannel(channelId: string): ConsultationIntakeRow | null {
    return (this.db.prepare(
      "SELECT * FROM consultation_intakes WHERE channel_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    ).get(channelId) as ConsultationIntakeRow | undefined) ?? null;
  }
}
