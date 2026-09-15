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

export type SessionMessageWorkSignal = "idle" | "progress";

/**
 * Discord へ届いたセッション投稿を作業状態のシグナルへ振り分ける。
 * 待機へ戻す契機はセッション自身のターン終了 (turnEnd = final_answer / summary)。
 * completion は委託 task カード専用で、通常セッションでは鳴らない (これだけに繋ぐと
 * 「作業中」が終了まで外れない)。
 */
export function classifySessionMessageWorkSignal(input: {
  completion: boolean;
  turnEnd: boolean;
}): SessionMessageWorkSignal {
  return input.completion || input.turnEnd ? "idle" : "progress";
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

  /**
   * summary / final_answer の投稿完了。working なら待機へ戻す。
   * 追跡状態が無い (Cc 再起動でメモリが消えた) 場合も待機へ戻す — DB と Discord には
   * 「作業中」が残っており、ここで捨てると次の進捗まで外れない。
   * 既に待機なら setWorking 側 (onSessionWorkState) が no-op にする。
   */
  noteCompletion(sessionId: string): void {
    const st = this.state.get(sessionId);
    if (st && !st.working) return;
    this.transition(sessionId, st ?? this.ensure(sessionId), false);
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
