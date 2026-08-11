/**
 * close 済みスレッドへの書き込みで archive 状態を失わないための境界。
 *
 * Discord の forum thread は archive 中は投稿も編集も拒否されるため、書き込む側は
 * 一度 unarchive する。 さらにスレッドへ新規メッセージが届くと Discord 自身が
 * 自動で unarchive する。 結果、Concordia が閉じたはずの投稿が書き込みのたびに
 * open へ戻り、誰も閉じ直さないまま残っていた (2026-08-09 neco 指摘)。
 *
 * 「閉じていたものは書き終えたら閉じ直す」を 1 箇所に閉じ込める。 元から open な
 * スレッドには何もしない。
 *
 * @implements spec/tasks/2026-08-09-spoken-session-end.md — 閉じた投稿の閉じ直し
 */

export interface ArchivableThread {
  archived: boolean | null;
  setArchived(archived: boolean, reason?: string): Promise<unknown>;
}

/**
 * `write` を実行し、開始時点で archive されていたら閉じ直す。
 *
 * 書き込みが失敗しても閉じ直す (失敗のたびに open が積み残るのを避ける)。 閉じ直し
 * 自体の失敗は握り潰さず呼び出し元へ返す — 静かに open のままにしない。
 */
export async function writeKeepingArchiveState<T>(
  thread: ArchivableThread,
  reason: string,
  write: () => Promise<T>,
): Promise<T> {
  const wasArchived = thread.archived === true;
  if (wasArchived) await thread.setArchived(false, reason);
  try {
    return await write();
  } finally {
    // Discord が自動 unarchive するので、書き込み後の状態を見てから閉じ直す。
    if (wasArchived && thread.archived !== true) {
      await thread.setArchived(true, `${reason} (re-closed)`);
    }
  }
}
