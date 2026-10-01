/**
 * 相談の後始末 (ConsultationClosureService) を Discord Bot の資源へつなぐ adapter (spec/feature/tech-consultation.md §7)。
 *
 * - セッションの停止・共有の問い・締め切りは Cc の API を通す (Tabula の秘密と公開の記録は Cc 本体が持つ)。
 * - 判定は Bot が持つヘッドレス実行 (claude -p、 会話のみ) で行う。
 * - チャンネルの削除はこの Bot の guild で行う。 既に無いチャンネルは「削除済み」として扱う。
 *
 * @implements SPEC-CONSULT-CLOSURE
 */

import type { Guild } from "discord.js";
import { ConsultationClosureService, type ChannelDeletion } from "../consultation/closure-service.js";
import type { TranscriptLine } from "../consultation/closure-policy.js";
import { loadConfidentialTerms } from "../consultation/confidential-terms.js";
import type { ConsultationPublicationsRepo } from "../db/consultation-publications-repo.js";
import type { PrivateConsultationsRepo } from "../db/private-consultations-repo.js";
import type { SessionMessagesRepo } from "../db/session-messages-repo.js";

/** 判定の締め切り。 claude -p は 1 回 8〜11 秒なので余裕を持たせる。 */
const JUDGE_TIMEOUT_MS = 180_000;
/** 判定に読む会話の件数 (新しい側)。 */
const TRANSCRIPT_MESSAGES = 200;
/** Discord の Unknown Channel。 */
const UNKNOWN_CHANNEL = 10003;

export interface ConsultClosureWiringDeps {
  consultations: PrivateConsultationsRepo;
  publications: Pick<ConsultationPublicationsRepo, "listForConsultation">;
  sessionMessages: Pick<SessionMessagesRepo, "list">;
  /** Cc の API を呼ぶ (callConcordia)。 失敗は `{ error }` を返す。 */
  callConcordia(method: "POST", path: string, body: unknown): Promise<unknown>;
  runHeadless(prompt: string, opts: { timeoutMs: number; conversationOnly: boolean }): Promise<{ ok: boolean; stdout: string; exit_code: number | null }>;
  confidentialTermsPath: string;
  projectNames(): readonly string[];
  guild(): Guild | null;
  log: { info(message: string): void; warn(message: string): void };
}

export function createConsultationClosure(deps: ConsultClosureWiringDeps): ConsultationClosureService {
  const succeeded = async (path: string, body: unknown): Promise<boolean> => {
    const result = await deps.callConcordia("POST", path, body);
    return !(result && typeof result === "object" && "error" in result);
  };
  return new ConsultationClosureService({
    store: deps.consultations,
    publications: (consultationId) => deps.publications.listForConsultation(consultationId),
    stopSession: (sessionId) => succeeded(`/v1/admin/stop-session/${encodeURIComponent(sessionId)}`, {}),
    transcript: (sessionId) => consultationTranscript(deps.sessionMessages, sessionId),
    judge: async (prompt) => {
      const result = await deps.runHeadless(prompt, { timeoutMs: JUDGE_TIMEOUT_MS, conversationOnly: true });
      if (!result.ok) throw new Error(`judge exited ${result.exit_code ?? "?"}`);
      return result.stdout;
    },
    leakTerms: async () => [...await loadConfidentialTerms(deps.confidentialTermsPath), ...deps.projectNames()],
    proposeShare: (consultationId, title, summary) =>
      succeeded(`/v1/consultations/${encodeURIComponent(consultationId)}/share-proposal`, { title, summary }),
    expireShare: (publicationId) => succeeded(`/v1/consultations/publications/${encodeURIComponent(publicationId)}/expire`, {}),
    deleteChannel: (channelId) => deleteGuildChannel(deps.guild(), channelId),
    log: deps.log,
  });
}

/** 相談者の発言 (Discord から入ったもの) と回答 (最終回答) だけを並べる。 指令や途中の発言は渡さない。 */
export function consultationTranscript(messages: Pick<SessionMessagesRepo, "list">, sessionId: string): TranscriptLine[] {
  return messages.list(sessionId, { limit: TRANSCRIPT_MESSAGES }).flatMap((message): TranscriptLine[] => {
    if (message.author_type === "user" && message.author_platform === "discord") return [{ role: "user", text: message.content }];
    if (message.author_type === "assistant" && message.metadata?.phase === "final_answer") {
      return [{ role: "assistant", text: message.content }];
    }
    return [];
  });
}

async function deleteGuildChannel(guild: Guild | null, channelId: string): Promise<ChannelDeletion> {
  if (!guild) return "failed";
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel) return "missing";
    await channel.delete("consultation closed");
    return "deleted";
  } catch (error) {
    return (error as { code?: unknown }).code === UNKNOWN_CHANNEL ? "missing" : "failed";
  }
}
