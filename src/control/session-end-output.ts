/**
 * セッション終了時の出力 (`/session-end` の自動指示と、 #報告 への独白) を出すかの判定口。
 *
 * 2026-10-02 neco 指示 (技術相談課): 相談はクローズしないので /session-end 的なものは投稿しない。
 * 「相談は FINAL ANSWER 以外を投稿しない」。 独白は #報告 に出るので、 非公開の相談の中身が漏れる経路でもある。
 *
 * 終了経路は 5 箇所から呼ばれるため、 deps に通さず起動時に判定関数を差し込む
 * (setWorkspaceRootsResolver と同じ形)。 control 層は部署を import しない。
 *
 * @implements SPEC-DEPT-OUTPUT
 */

type SessionEndOutputResolver = (sessionId: string) => boolean;

let resolver: SessionEndOutputResolver | null = null;

/** 起動時に部署の出力方針 (output.session_end_report) を見る判定関数を差し込む。 */
export function setSessionEndOutputResolver(next: SessionEndOutputResolver | null): void {
  resolver = next;
}

/** 終了時の自動指示と独白を出すか。 未設定・判定失敗は従来どおり出す。 */
export function sessionEndOutputEnabled(sessionId: string): boolean {
  if (!resolver) return true;
  try {
    return resolver(sessionId);
  } catch {
    return true;
  }
}
