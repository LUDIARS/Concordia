/**
 * WorkingIndicator — セッションが作業中である間、チャンネルの「最後のメッセージ」
 * として「作業中」表示を出し続ける。進捗（AI の出力など）が来たら一旦消し、少し
 * 落ち着いてから最下部に出し直す。一定時間 transcript が動かなければ（idle）除去する。
 *
 * 仕様（ユーザ指示）:
 *   「指令を受け付けて transcript が動いている間は『作業中』というメッセージを必ず
 *    最後に投稿し、進捗があった際は消すようにする。」
 *
 * 設計上の要点:
 *   - 進捗ごとに即削除 → `repostDelayMs` 後に再投稿。これでストリーミング中の
 *     delete/post フリッカを抑えつつ、egress が本文を投稿し終えた後に「作業中」が
 *     最下部へ回る（順序保証）。
 *   - `idleMs` 無進捗で除去（= 作業が止まった／入力待ち）。idleMs > repostDelayMs。
 *   - per-session に操作を promise チェーンで直列化し、delete/post の取り違えを防ぐ。
 *
 * post/remove はプラットフォーム依存なのでコールバック注入。Discord/Slack 双方から
 * 同じコントローラを使える（platform 非依存）。
 */

export interface WorkingIndicatorDeps {
  /** セッションのチャンネルへ「作業中」を投稿し、message id を返す（失敗時 null）。 */
  post: (sessionId: string) => Promise<string | null>;
  /** 以前投稿した「作業中」を削除する。 */
  remove: (sessionId: string, messageId: string) => Promise<void>;
  /** 進捗が落ち着いたとみなして再投稿するまでの待ち（ms）。既定 1500。 */
  repostDelayMs?: number;
  /** 無進捗で除去するまでの待ち（ms）。既定 60000。repostDelayMs より大きいこと。 */
  idleMs?: number;
  log?: (m: string) => void;
}

interface SessionState {
  msgId: string | null;
  repostTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** per-session 直列化チェーン。 */
  chain: Promise<void>;
}

export class WorkingIndicator {
  private readonly state = new Map<string, SessionState>();
  private readonly repostDelayMs: number;
  private readonly idleMs: number;
  private readonly log: (m: string) => void;

  constructor(private readonly deps: WorkingIndicatorDeps) {
    this.repostDelayMs = deps.repostDelayMs ?? 1500;
    this.idleMs = deps.idleMs ?? 60_000;
    this.log = deps.log ?? (() => {});
  }

  /** transcript が動いた（AI 出力等の進捗）。即削除 → settle 後に再投稿。 */
  noteProgress(sessionId: string): void {
    const st = this.ensure(sessionId);
    // 進捗が来た = 既存の「作業中」は最下部でなくなる → 即削除。
    this.enqueue(st, async () => {
      if (st.msgId) {
        const id = st.msgId;
        st.msgId = null;
        try { await this.deps.remove(sessionId, id); } catch (e) { this.log(`remove failed: ${(e as Error).message}`); }
      }
    });
    this.armRepost(sessionId, st);
    this.armIdle(sessionId, st);
  }

  /** セッション終了 / lost: 「作業中」を消してタイマ解除。 */
  clear(sessionId: string): void {
    const st = this.state.get(sessionId);
    if (!st) return;
    if (st.repostTimer) clearTimeout(st.repostTimer);
    if (st.idleTimer) clearTimeout(st.idleTimer);
    st.repostTimer = null;
    st.idleTimer = null;
    this.enqueue(st, async () => {
      if (st.msgId) {
        const id = st.msgId;
        st.msgId = null;
        try { await this.deps.remove(sessionId, id); } catch (e) { this.log(`remove failed: ${(e as Error).message}`); }
      }
    });
    // チェーン完了は待たず state は残す（同 session 再開時に再利用）。
  }

  /** テスト用: 現在「作業中」が出ているか。 */
  hasIndicator(sessionId: string): boolean {
    return !!this.state.get(sessionId)?.msgId;
  }

  private ensure(sessionId: string): SessionState {
    let st = this.state.get(sessionId);
    if (!st) {
      st = { msgId: null, repostTimer: null, idleTimer: null, chain: Promise.resolve() };
      this.state.set(sessionId, st);
    }
    return st;
  }

  private armRepost(sessionId: string, st: SessionState): void {
    if (st.repostTimer) clearTimeout(st.repostTimer);
    st.repostTimer = setTimeout(() => {
      st.repostTimer = null;
      this.enqueue(st, async () => {
        if (st.msgId) return; // 既に出ている
        try {
          const id = await this.deps.post(sessionId);
          st.msgId = id;
        } catch (e) {
          this.log(`post failed: ${(e as Error).message}`);
        }
      });
    }, this.repostDelayMs);
    st.repostTimer.unref?.();
  }

  private armIdle(sessionId: string, st: SessionState): void {
    if (st.idleTimer) clearTimeout(st.idleTimer);
    st.idleTimer = setTimeout(() => {
      st.idleTimer = null;
      if (st.repostTimer) { clearTimeout(st.repostTimer); st.repostTimer = null; }
      this.enqueue(st, async () => {
        if (st.msgId) {
          const id = st.msgId;
          st.msgId = null;
          try { await this.deps.remove(sessionId, id); } catch (e) { this.log(`remove failed: ${(e as Error).message}`); }
        }
      });
    }, this.idleMs);
    st.idleTimer.unref?.();
  }

  /** per-session 直列化。前の操作の完了を待ってから次を実行。 */
  private enqueue(st: SessionState, op: () => Promise<void>): void {
    st.chain = st.chain.then(op, op);
  }
}
