import { createSessionSuccessionCommand } from "./session-succession.js";

/**
 * /co-handover — このセッションの作業を次のセッションへ移行する (自動引き継ぎ)。
 *
 * /co-compaction が「同一セッションで /clear して続行」なのに対し、 こちらは
 * 「セッション自身が引き継ぎ資料を書く → 新セッションを spawn → このセッションを終了 →
 * 新セッションが資料を読んで続行」。 session id とチャンネルは新しくなる。
 * spec/tasks/2026-08-14-handover-command.md。
 */
const handoverCommand = createSessionSuccessionCommand({
  name: "co-handover",
  description: "次のセッションへ移行 (自筆引き継ぎ資料→新セッション spawn→このセッション終了)",
  endpoint: "handover",
  startingMessage: "🤝 次のセッションへ移行します (引き継ぎ資料を自筆→新セッション spawn→このセッション終了)…",
  completedMessage: "✅ 次のセッションを起動しました。引き継ぎ資料を読んで続行します。このチャンネルは間もなく終了します。",
});

export default handoverCommand;
