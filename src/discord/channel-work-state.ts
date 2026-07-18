/**
 * ChannelWorkState — セッションの「作業中 ⟷ idle」をチャンネル名の状態絵文字に反映する
 * ための per-session トラッカー。prompt / transcript の進捗で「作業中」に入り、
 * summary / final_answer が Discord へ投稿された時点で idle に戻す。
 *
 * per-session の更新を直列化し、短い応答でも「作業中を付与」より先に「待機へ戻す」が
 * Discordへ到着して順序が逆転しないようにする。
 */

export interface ChannelWorkStateDeps {
  /** 状態が変化したとき呼ぶ (working=true で作業中、false で idle 復帰)。 */
  setWorking: (sessionId: string, working: boolean) => void | Promise<void>;
  log?: (m: string) => void;
}

interface State {
  working: boolean;
  chain: Promise<void>;
}

export class ChannelWorkState {
  private readonly state = new Map<string, State>();
  private readonly log: (m: string) => void;

  constructor(private readonly deps: ChannelWorkStateDeps) {
    this.log = deps.log ?? (() => {});
  }

  /** transcript / prompt の進捗。working でなければ working に遷移する。 */
  noteProgress(sessionId: string): void {
    const st = this.ensure(sessionId);
    if (st.working) return;
    this.transition(sessionId, st, true);
  }

  /** summary / final_answer の投稿完了。working なら待機へ戻す。 */
  noteCompletion(sessionId: string): void {
    const st = this.state.get(sessionId);
    if (!st?.working) return;
    this.transition(sessionId, st, false);
  }

  /** セッション終了 / lost: state を捨てる (状態タグ更新は status 側が担当)。 */
  clear(sessionId: string): void {
    this.state.delete(sessionId);
  }

  /** テスト用: 現在 working とみなしているか。 */
  isWorking(sessionId: string): boolean {
    return this.state.get(sessionId)?.working ?? false;
  }

  private ensure(sessionId: string): State {
    let st = this.state.get(sessionId);
    if (!st) {
      st = { working: false, chain: Promise.resolve() };
      this.state.set(sessionId, st);
    }
    return st;
  }

  private transition(sessionId: string, st: State, working: boolean): void {
    st.working = working;
    this.log(`${sessionId} → ${working ? "working" : "idle"}`);
    st.chain = st.chain.then(
      () => this.deps.setWorking(sessionId, working),
      () => this.deps.setWorking(sessionId, working),
    ).catch((error) => {
      this.log(`${sessionId} state update failed: ${(error as Error).message}`);
    });
  }
}
