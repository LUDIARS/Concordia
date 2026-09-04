/**
 * 注入された指示の出所 (provenance)。
 *
 * reaction workflow は「ユーザーが絵文字を押した」を「セッションへの指示文」へ変換する。
 * その結果できた session message は、**見た目がユーザーの直接入力と区別できない**。
 * どちらも `author_type: "user"` で本文だけが載る。
 *
 * これが問題になるのは 2 つの場面。
 *
 * 1. モデルへ渡す入力で、**workflow が生成した指示とユーザーが自分で書いた文が混ざる**。
 *    前者は絵文字 1 つから機械的に展開されたテンプレートなので、後者と同じ重みで
 *    読むべきものではない。
 * 2. あとから「この指示は誰がどのメッセージに反応して出したのか」を辿れない。
 *    誤爆 (誤ダブルタップ等) の調査ができない。
 *
 * そこで注入経路から session message の正本まで出所を運ぶ。
 *
 * @implements spec/tasks/2026-08-31-reaction-injection-provenance.md
 */

/** 注入がどこから来たか。 platform は発火元のチャットプラットフォーム。 */
export interface InjectionProvenance {
  /** 出所の種類。 `reaction-workflow` 以外は将来の拡張余地。 */
  readonly kind: "reaction-workflow";
  /** 発火した workflow action (handoff-document / context-report など)。 */
  readonly action: string;
  /** 発火元のプラットフォーム。 */
  readonly platform: "discord" | "slack";
  /** 反応された絵文字。 誤爆調査で「どれを押したか」が要る。 */
  readonly emoji?: string;
  /** 発火元メッセージの ID。 プラットフォーム内で一意。 */
  readonly sourceMessageId?: string;
  /** 発火したユーザーの platform user ID。 */
  readonly actorId?: string;
}

export type SessionInjectEmitter = (
  sessionId: string,
  text: string,
  source: string,
  provenance?: InjectionProvenance,
) => void;

/**
 * `session.inject` の `source` 文字列から platform を引く既存の規則に合わせた prefix。
 * source は後方互換のため文字列のまま残し、 構造化した出所は別フィールドで運ぶ。
 */
export const REACTION_WORKFLOW_SOURCE = "reaction-workflow";
