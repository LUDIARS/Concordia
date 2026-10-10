/**
 * WorkingPost — Discord のセッションスレッドに「🔄 作業中…」を 1 通だけ出す。
 *
 * 2026-10-10 neco 指示: 作業中か停止中かがわかりづらくなった。 作業中の時に「作業中…」を
 * 投稿するやつをエンジニア課以外で復活させる (spec/feature/working-indicator.md)。
 *
 * 作業中タグ (ChannelWorkState) と同じ契機で動く。 作業に入ったら 1 回投稿し、 待機に戻る・
 * lost・ended で消す。 進捗ごとの削除・再投稿はしない — 2026-07-18 にそれで Forum 投稿が
 * 一覧の上へ浮き続けたため (spec/plan/problem_logs/2026-07-18-discord-working-post-noise.md)。
 * 出すかどうかは部署の出力方針 `working_post` (departments.md §9.4) が決める。
 *
 * @implements SPEC-DEPT-OUTPUT
 */

export const WORKING_POST_TEXT = "🔄 **作業中…**";

export interface WorkingPostDeps {
  /** このセッションで「作業中…」を出すか (部署の出力方針)。 */
  enabled: (sessionId: string) => boolean;
  /** スレッドへ投稿し message id を返す (失敗は null)。 */
  post: (sessionId: string) => Promise<string | null>;
  /** 投稿済みの「作業中…」を消す。 */
  remove: (sessionId: string, messageId: string) => Promise<void>;
  log?: (m: string) => void;
}

interface State {
  messageId: string | null;
  chain: Promise<void>;
}

export class WorkingPost {
  private readonly state = new Map<string, State>();
  private readonly log: (m: string) => void;

  constructor(private readonly deps: WorkingPostDeps) {
    this.log = deps.log ?? (() => {});
  }

  /** 作業中タグの付け外しに合わせて投稿・削除する。 */
  setWorking(sessionId: string, working: boolean): Promise<void> {
    const st = this.ensure(sessionId);
    return this.enqueue(st, async () => {
      if (working) {
        if (st.messageId || !this.deps.enabled(sessionId)) return;
        st.messageId = await this.deps.post(sessionId);
      } else {
        await this.removeCurrent(sessionId, st);
      }
    });
  }

  /** セッション終了 / lost: 投稿を消して追跡をやめる。 */
  clear(sessionId: string): Promise<void> {
    const st = this.state.get(sessionId);
    if (!st) return Promise.resolve();
    const done = this.enqueue(st, () => this.removeCurrent(sessionId, st));
    void done.then(() => { if (this.state.get(sessionId) === st && !st.messageId) this.state.delete(sessionId); });
    return done;
  }

  /** テスト用: 「作業中…」が出ているか。 */
  hasPost(sessionId: string): boolean {
    return Boolean(this.state.get(sessionId)?.messageId);
  }

  private async removeCurrent(sessionId: string, st: State): Promise<void> {
    if (!st.messageId) return;
    const id = st.messageId;
    st.messageId = null;
    await this.deps.remove(sessionId, id);
  }

  private ensure(sessionId: string): State {
    let st = this.state.get(sessionId);
    if (!st) {
      st = { messageId: null, chain: Promise.resolve() };
      this.state.set(sessionId, st);
    }
    return st;
  }

  /** per-session 直列化。 付与より先に解除が届く逆転を防ぐ。 失敗はログだけ残して次へ進む。 */
  private enqueue(st: State, op: () => Promise<void>): Promise<void> {
    st.chain = st.chain.then(op).catch((e: unknown) => this.log(`working post failed: ${(e as Error).message}`));
    return st.chain;
  }
}
