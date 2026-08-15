import { createSessionSuccessionCommand } from "./session-succession.js";

/**
 * /co-relictor — このセッションを最新版 Lictor で再起動する (文脈引き継ぎ)。
 * Lictor は claude を pty 子に抱えるため単体再 exec できない → ラップ中セッションごと
 * 再起動する。引き継ぎ資料を生成・投稿 → 新セッション spawn (最新 dist) → 旧セッション終了。
 * 新セッションは引き継ぎ資料を読んで文脈を復元して続行する。session id とチャンネルは新しくなる。
 */
const relictorCommand = createSessionSuccessionCommand({
  name: "co-relictor",
  description: "このセッションを最新版 Lictor で再起動 (文脈引き継ぎ・新セッション spawn)",
  endpoint: "relictor",
  startingMessage: "🔁 最新 Lictor で再起動します (引き継ぎ資料を生成→新セッション spawn→このセッション終了)…",
  completedMessage: "✅ 新セッションを起動しました。引き継ぎ資料を読んで続行します。このチャンネルは間もなく終了します。",
});

export default relictorCommand;
