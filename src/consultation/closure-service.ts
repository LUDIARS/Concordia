/**
 * プライベート相談の後始末 (spec/feature/tech-consultation.md §7、 2026-10-02 neco 指示)。
 *
 * - 起動から 24 時間で、 開いている相談のセッションを止める (止まれば終了として閉じる)。
 * - 閉じた相談は、 本社なら会話を判定し、 センシティブでなく公開できるときだけ「この内容を全体共有しますか？」を出す。
 *   判定の要約に秘匿語や Cc のプロジェクト名が残っていれば出さない。 子会社の相談は問わずに閉じる。
 * - 共有の問いに 24 時間反応がなければ「共有しない」。 答えが出たら終える (done)。
 * - チャンネルはすぐには消さず、 次の見回り (24 時間のおそうじ) でまとめて消す
 *   (2026-10-02 neco 指示「速攻消さずに 24 時間のおそうじで一緒に消す」)。 フォーラムの公開相談は対象外で、
 *   総務と同じくクローズして残す (このサービスはプライベート相談だけを扱う)。
 * - セッションは共有の答えを待たない (閉じた後に問う)。
 *
 * 状態は private_consultations.wrap_status (pending → asking → done) が正本。 1 段ずつ条件付きで進めるので、
 * 見回りとイベントが重なっても二重に問わない。 判定・投稿・削除の失敗は状態を進めずに残し、 次の見回りで再試行する。
 *
 * @implements SPEC-CONSULT-CLOSURE
 */

import type { ConsultationPublicationRow } from "../db/consultation-publications-repo.js";
import type { PrivateConsultationRow, PrivateConsultationsRepo } from "../db/private-consultations-repo.js";
import {
  buildShareJudgePrompt,
  countLeakedTerms,
  isConsultationOverdue,
  isShareAnswerOverdue,
  parseShareJudgement,
  renderConsultationTranscript,
  type TranscriptLine,
} from "./closure-policy.js";

export type ChannelDeletion = "deleted" | "missing" | "failed";

export interface ConsultationClosurePorts {
  store: Pick<PrivateConsultationsRepo,
    "find" | "markClosed" | "listOpen" | "listClosedPendingWrap" | "listAsking" | "listDoneWithChannel"
    | "advanceWrap" | "markChannelDeleted">;
  publications(consultationId: string): ConsultationPublicationRow[];
  /** 相談のセッションを止める。 止まれば session.ended で closeConsultation が呼ばれる。 */
  stopSession(sessionId: string): Promise<boolean>;
  transcript(sessionId: string): TranscriptLine[];
  /** ヘッドレスの判定 (claude -p)。 標準出力を返す。 失敗は例外。 */
  judge(prompt: string): Promise<string>;
  /** 公開候補に残っていてはいけない語 (秘匿語辞書 + Cc のプロジェクト名)。 */
  leakTerms(): Promise<readonly string[]>;
  proposeShare(consultationId: string, title: string, summary: string): Promise<boolean>;
  expireShare(publicationId: string): Promise<boolean>;
  deleteChannel(channelId: string): Promise<ChannelDeletion>;
  log: { info(message: string): void; warn(message: string): void };
  now?: () => number;
}

type ShareCandidate = { title: string; summary: string };

export class ConsultationClosureService {
  private readonly now: () => number;
  /** 判定中の相談 (同じ相談を並行して判定しない)。 */
  private readonly judging = new Set<string>();

  constructor(private readonly ports: ConsultationClosurePorts) {
    this.now = ports.now ?? Date.now;
  }

  /** セッションの終了・消失を受けて閉じ、 後始末を始める。 */
  async closeConsultation(consultationId: string): Promise<void> {
    this.ports.store.markClosed(consultationId, this.now());
    const consultation = this.ports.store.find(consultationId);
    if (consultation) await this.wrap(consultation);
  }

  /** 共有の答えが出た (公開・共有しない・取り下げ) ら終える。 チャンネルは次の見回りで消す。 */
  async onShareDecided(consultationId: string): Promise<void> {
    this.ports.store.advanceWrap(consultationId, "asking", "done", this.now());
  }

  /** 定期の見回り。 期限・取りこぼし・削除の再試行をまとめて進める。 */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const consultation of this.ports.store.listOpen()) {
      if (!isConsultationOverdue(consultation, now)) continue;
      // セッションが無い (起動前・失敗) か止められなければ、 直接閉じる。
      const stopped = consultation.session_id
        ? await this.ports.stopSession(consultation.session_id).catch(() => false)
        : false;
      if (!stopped) await this.closeConsultation(consultation.id);
    }
    for (const consultation of this.ports.store.listClosedPendingWrap()) await this.wrap(consultation);
    for (const consultation of this.ports.store.listAsking()) await this.checkAnswer(consultation, now);
    for (const consultation of this.ports.store.listDoneWithChannel()) await this.removeChannel(consultation.id);
  }

  private async wrap(consultation: PrivateConsultationRow): Promise<void> {
    if (consultation.status !== "closed" || consultation.wrap_status !== "pending") return;
    if (this.judging.has(consultation.id)) return;
    this.judging.add(consultation.id);
    try {
      const share = consultation.subsidiary_id === null ? await this.judgeShare(consultation) : null;
      if (share === "retry") return;
      if (share) {
        // 投稿できなければ pending のまま。 次の見回りで判定からやり直す。
        if (await this.ports.proposeShare(consultation.id, share.title, share.summary)) {
          this.ports.store.advanceWrap(consultation.id, "pending", "asking", this.now());
        }
        return;
      }
      // 共有しない。 チャンネルは次の見回りで消す。
      this.ports.store.advanceWrap(consultation.id, "pending", "done", this.now());
    } finally {
      this.judging.delete(consultation.id);
    }
  }

  /** 共有候補 (公開できる) / null (共有しない) / retry (判定できなかった)。 */
  private async judgeShare(consultation: PrivateConsultationRow): Promise<ShareCandidate | null | "retry"> {
    const lines = consultation.session_id ? this.ports.transcript(consultation.session_id) : [];
    const transcript = renderConsultationTranscript(lines);
    if (!transcript) return null;
    let stdout: string;
    try {
      stdout = await this.ports.judge(buildShareJudgePrompt(transcript));
    } catch (error) {
      this.ports.log.warn(`consultation share judge failed consultation=${consultation.id}: ${(error as Error).message}`);
      return "retry";
    }
    const judgement = parseShareJudgement(stdout);
    if (!judgement.publishable) return null;
    const leaked = countLeakedTerms(`${judgement.title}\n${judgement.summary}`, await this.ports.leakTerms());
    if (leaked > 0) {
      // 語は記録に残さない (辞書を流出させない)。 件数だけ。
      this.ports.log.info(`consultation share withheld consultation=${consultation.id} leaked_terms=${leaked}`);
      return null;
    }
    return { title: judgement.title, summary: judgement.summary };
  }

  private async checkAnswer(consultation: PrivateConsultationRow, now: number): Promise<void> {
    const pending = this.ports.publications(consultation.id).find((publication) => publication.status === "proposed");
    if (!pending) {
      // カードの操作で答えが出ている (または候補が無い)。 終える。
      await this.onShareDecided(consultation.id);
      return;
    }
    if (consultation.share_asked_at !== null && isShareAnswerOverdue(consultation.share_asked_at, now)) {
      if (await this.ports.expireShare(pending.id)) await this.onShareDecided(consultation.id);
    }
  }

  private async removeChannel(consultationId: string): Promise<void> {
    const consultation = this.ports.store.find(consultationId);
    if (!consultation?.channel_id || consultation.channel_deleted_at !== null) return;
    const result = await this.ports.deleteChannel(consultation.channel_id);
    if (result === "failed") {
      this.ports.log.warn(`consultation channel delete failed consultation=${consultationId}`);
      return;
    }
    this.ports.store.markChannelDeleted(consultationId, this.now());
  }
}
