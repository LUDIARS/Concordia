/**
 * ChatPlatform — Concordia を「運用」できるチャット基盤の共通契約。
 *
 * Concordia 自体は LLM も UI も持たず、eventBus に流れるセッション内 event を
 * 各 ChatPlatform が購読して人間に見せ、人間の入力を Concordia の HTTP API
 * (`/v1/sessions/:id/inject` `/v1/chat` `/v1/sessions/:id/answer-question`)
 * に戻す。Discord と Slack はこの契約を満たす coequal な実装で、両方を同時に
 * 起動できる（どちらも eventBus を独立に購読する。eventBus は複数購読対応）。
 *
 * abstraction の本体は「eventBus（出力の共通源）」と「Concordia HTTP API
 * （入力の共通宛先）」で、両者とも既に platform 非依存。ChatPlatform は
 * その上に乗る起動/停止のライフサイクル契約を与える薄い層。
 *
 * 既存ダッシュボード（cost / monitor / pr-queue / status-card / session
 * channel CRUD 等）は Discord 固有の付加価値であり、契約には含めない。Slack は
 * 運用の中核（出力監視・inject・question 回答）だけを実装する（v0.1）。
 */
export interface ChatPlatform {
  readonly name: "discord" | "slack";
  /** 接続を閉じてタイマ/購読を解除する。多重 stop は安全（冪等）であること。 */
  stop(): Promise<void>;
}

export type ChatPlatformStatus =
  | "started"
  | "already_running"
  | "disabled"
  | "stopped"
  | "already_stopped"
  | "error";
