/**
 * ChannelWorkState — セッションの「作業中 ⟷ idle」をチャンネル名の状態絵文字に反映する
 * ための per-session トラッカー。transcript / prompt の進捗で「作業中」に入り、一定時間
 * (既定 600 秒) 進捗が無ければ「idle (緑に戻す)」へ落とす。
 *
 * なぜ 600 秒か: Discord のチャンネル名変更は 10 分あたり 2 回に制限される。idle 復帰を
 * 600 秒 (= 10 分) に合わせると、作業開始の 1 回 + idle 復帰の 1 回で概ね budget 内に収まる。
 *
 * 実際の rename は best-effort (cooldown で skip され得る) なので、ここでは「状態が変わった
 * 瞬間」だけ setWorking を呼ぶ。連続進捗では再通知しない (working 維持)。
 */

export interface ChannelWorkStateDeps {
  /** 状態が変化したとき呼ぶ (working=true で作業中、false で idle 復帰)。 */
  setWorking: (sessionId: string, working: boolean) => void;
  /** idle 判定までの無進捗時間 (ms)。既定 600_000 (= 10 分)。 */
  idleMs?: number;
  log?: (m: string) => void;
}

interface State {
  working: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class ChannelWorkState {
  private readonly state = new Map<string, State>();
  private readonly idleMs: number;
  private readonly log: (m: string) => void;

  constructor(private readonly deps: ChannelWorkStateDeps) {
    this.idleMs = deps.idleMs ?? 600_000;
    this.log = deps.log ?? (() => {});
  }

  /** transcript / prompt の進捗。working でなければ working に遷移し、idle タイマを張り直す。 */
  noteProgress(sessionId: string): void {
    const st = this.ensure(sessionId);
    if (!st.working) {
      st.working = true;
      this.log(`${sessionId} → working`);
      this.deps.setWorking(sessionId, true);
    }
    this.armIdle(sessionId, st);
  }

  /** セッション終了 / lost: タイマ解除して state を捨てる (rename は status 側が担当)。 */
  clear(sessionId: string): void {
    const st = this.state.get(sessionId);
    if (!st) return;
    if (st.idleTimer) clearTimeout(st.idleTimer);
    this.state.delete(sessionId);
  }

  /** テスト用: 現在 working とみなしているか。 */
  isWorking(sessionId: string): boolean {
    return this.state.get(sessionId)?.working ?? false;
  }

  private ensure(sessionId: string): State {
    let st = this.state.get(sessionId);
    if (!st) {
      st = { working: false, idleTimer: null };
      this.state.set(sessionId, st);
    }
    return st;
  }

  private armIdle(sessionId: string, st: State): void {
    if (st.idleTimer) clearTimeout(st.idleTimer);
    st.idleTimer = setTimeout(() => {
      st.idleTimer = null;
      if (st.working) {
        st.working = false;
        this.log(`${sessionId} → idle`);
        this.deps.setWorking(sessionId, false);
      }
    }, this.idleMs);
    st.idleTimer.unref?.();
  }
}
