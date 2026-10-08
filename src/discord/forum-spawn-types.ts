/** Supplied forum launch content shared by command and spawn ports. */
import type { ForumTagState } from "./forum-system-tag.js";
export interface SuppliedForumSpawnContent {
  readonly title: string;
  readonly body: string;
  readonly tagState?: ForumTagState;
  /** 不足情報の回答 (テンプレ選択メニュー) で確定した起動テンプレ。 selector を通さず使う。 */
  readonly template?: string;
  /** 不足情報の回答 (プロジェクト選択メニュー) で確定した関係プロジェクト。 registry 再解決に賭けない。 */
  readonly project?: string;
  /** モデル/Effort 質問カードで確定した起動モデル (nickname: fable / opus / sonnet / sol / terra)。 */
  readonly model?: string;
  /** モデル質問カードで選んだ effort。 未指定は provider 既定 (claude=high / codex=xhigh)。 */
  readonly effort?: string;
  /** 起動先の質問で選んだ拠点 ID (本社は FORUM_SPAWN_HQ_SITE)。 */
  readonly site?: string;
}
