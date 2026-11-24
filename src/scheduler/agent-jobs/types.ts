/**
 * 外部エージェントへ回す定時ジョブ 1 本分の定義 (本文・data builder・結果の出し方)。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — ジョブごとの定義
 */

/** 発火 1 回 (fanout なら対象 1 つ) の文脈。 */
export interface AgentJobContext {
  firedAt: Date;
  /** fanout の対象キー。 fanout 無しは ""。 */
  targetKey: string;
  /** ジョブ既定 + 対象の args (日付・チーム id など)。 */
  args: Record<string, unknown>;
}

/** Cc が投稿する結果の表示種別 (CC-PT-AGENT-INV-04)。 */
export type AgentJobResultKind = "報告" | "提案" | "下書き" | "要約";

export interface AgentJobSpec {
  jobName: string;
  /** 外部エージェント用の本文 (Cc の API・ファイル操作・投稿の手順は含めない)。 */
  body: string;
  resultKind: AgentJobResultKind;
  /** Optional HQ work before building data. null means another caller holds the firing reservation. */
  prepare?(dedupeKey: string): Promise<Record<string, unknown> | null>;
  /**
   * 判断に要る最小の読み取りデータ。 配列は重要度の高い順に並べる (上限超過時は末尾から落ちる)。
   * 秘密・個人の連絡先・メール本文・未公開コード本文は入れない (CC-PT-AGENT-INV-03)。
   */
  buildData(context: AgentJobContext, prepared?: Record<string, unknown>): Promise<Record<string, unknown>>;
}
