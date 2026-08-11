/**
 * 未回答の質問を **blocker** として扱い、自動 inject を止める門番。
 *
 * ## なぜ要るか
 *
 * セッションが ask カードを出して人間の判断を待っている間にも、Concordia は
 * 「進め」と言う inject を自動で送っていた — goal-and-go の自走継続、作業完了時の
 * お伺い、taskflow の分解/完了プロンプト。これらは pty には user メッセージとして
 * 届くため、モデルは **自分の質問に自分で答えて** 先へ進んでしまう。人間から見ると
 * 「答えていないのに勝手に決まった」状態になる。
 *
 * そこで自動 inject を出す各所は、送る前にここで「この session に未回答の質問が
 * 残っていないか」を確認する。残っていれば送らない = 回答するまで進まない。
 *
 * ## 何を止めないか
 *
 * - **人間の発言** (Discord / Slack のチャット) — 会話まで止める必要は無い。
 * - **回答そのもの** (`question.answered`) — 別経路 (answer-question) なのでここを通らない。
 * - **終了指示** (`auto:session-end`) — 人が `/end-session` を叩いた結果であり、
 *   止めると `/session-end` を走らせないままセッションが死ぬ。
 *
 * Lictor 側にも同じ意図の gate があり (`spec/feature/askquestion-pending-gate.md`)、
 * 取りこぼした自動 inject は pty 直前で保留される。こちらは「そもそも送らない」層で、
 * 継続回数カウンタを無駄に消費しないためと、止まった理由をログに残すためにある。
 *
 * SRP: 未回答質問の有無の問い合わせと判定のみ。DB アクセスの実体は呼び出し側が注入する。
 */

/**
 * 未回答質問の有無を返す関数。実体は
 * `DiscordPendingQuestionsRepo.findLatestUnanswered` で、ここは repo 型に依存しない
 * ための注入点 (control 層が db 層を直接引き込まない)。
 */
export type PendingQuestionProbe = (sessionId: string) => boolean;

/**
 * `discord_pending_questions` を正本に probe を作る。 表示上の状態や transcript の
 * 走査ではなく **未回答行の有無** を見るので、ask マーカー / picker / WebUI のどの
 * 経路で出した質問でも同じ判定になる。
 */
export function pendingQuestionProbe(
  repo: { findLatestUnanswered(sessionId: string): unknown },
): PendingQuestionProbe {
  return (sessionId) => repo.findLatestUnanswered(sessionId) !== null;
}

/** 未回答の質問があるか。probe 未注入 (テスト・部分構成) は「無い」扱いで従来動作。 */
export function isBlockedByPendingQuestion(
  probe: PendingQuestionProbe | undefined,
  sessionId: string,
): boolean {
  if (!probe) return false;
  try {
    return probe(sessionId);
  } catch {
    // 未回答の有無を確認できない間は送らない。ここで通すと DB 障害中だけ
    // 質問待ちのセッションへ自動 inject でき、blocker の安全契約を破ってしまう。
    return true;
  }
}

/**
 * 自動 inject を送ってよいか。送らない場合は理由を 1 行ログに残す
 * (「何も起きない」を無言にしないため)。
 */
export function allowAutoInject(input: {
  probe: PendingQuestionProbe | undefined;
  sessionId: string;
  /** ログに出す inject の出どころ (`auto:goal-and-go` 等)。 */
  source: string;
  log?: { info: (message: string) => void };
}): boolean {
  if (!isBlockedByPendingQuestion(input.probe, input.sessionId)) return true;
  input.log?.info(
    `auto inject skipped: unanswered question blocks session=${input.sessionId} source=${input.source}`,
  );
  return false;
}
