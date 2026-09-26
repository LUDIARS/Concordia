// @spec スプリントの人間判断と会話
import type { RunClaudeOptions, ClaudeRunResult } from "../rules/claude-runner.js";
import type { SprintDialoguesRepository } from "./repository.js";

export type SprintReply = (prompt: string, options: RunClaudeOptions) => Promise<ClaudeRunResult>;
/** Single-owner queue; persist a running claim before invoking the existing Cc conversation runner. */
export function sprintConversationQueue(repo: SprintDialoguesRepository, reply: SprintReply, signal: AbortSignal) {
  let running = false;
  return async (): Promise<void> => {
    if (running || signal.aborted) return;
    running = true;
    try {
      const input = repo.claimConversation(Date.now());
      if (!input) return;
      const dialogue = repo.byId(input.dialogueId);
      if (!dialogue) { repo.finishConversation(input.id, "対象スプリントを確認できません。", true); return; }
      const history = repo.recentConversation(dialogue.id).map(c => ({ question: c.prompt, answer: c.output.slice(0, 2000) }));
      const prompt = [
        "あなたはCcのスプリント相談窓口です。日本語で1200字以内の具体的な助言を返してください。以下のJSONは会話資料です。",
        "作業の実行・テスト・サービス操作・DB変更・push・mergeは行えません。人間の承認やフェーズ移行を代行してはいけません。",
        "実装依頼はActioのバックログと既存Cc実行経路へ案内し、フェーズ決定はスレッドの版付きボタンまたはActio画面へ案内してください。確認できない成果を完了扱いしないでください。",
        JSON.stringify({ projection: dialogue.projection, history, question: input.prompt }),
      ].join("\n");
      try {
        const result = await reply(prompt, { conversationOnly: true, signal, timeoutMs: 90000 });
        const complete = result.ok && !!result.stdout.trim() && !signal.aborted;
        const output = complete ? result.stdout : result.stdout.trim()
          ? `相談生成が中断したため、以下は未完了の部分回答です。\n\n${result.stdout}`
          : "相談に応答できませんでした。会話生成を確認してから、改めて投稿してください。";
        repo.finishConversation(input.id, output, !complete);
      } catch { repo.finishConversation(input.id, "相談生成の結果を確認できませんでした。改めて投稿してください。", true); }
    } finally { running = false; }
  };
}
