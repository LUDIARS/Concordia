/**
 * 管制チャンネル面 (Discord など) が管制へ差し出す口。組み立て (runtime) に依存させないため型だけを置く。
 *
 * @implements spec/feature/control-session.md — 3. 管制チャンネルと側セッション
 */
export interface ControlChannelSurface {
  /** 管制チャンネルを用意する (ON の間だけ呼ばれる・冪等)。 */
  ensure(): Promise<void>;
  /** 管制チャンネルへの通知 (本文は件数と対象だけ)。 */
  post(text: string): Promise<boolean | void>;
}
