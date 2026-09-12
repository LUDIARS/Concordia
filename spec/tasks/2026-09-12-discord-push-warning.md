---
task: discord-push-warning
project: Concordia
kind: 実装
created: 2026-09-12
memory_links: []
---
# DiscordでpushのWARNING承認を受ける
## 目的
Windowsの警告が見えない利用者がDiscord上で対象を確認し、今回だけのpushを承認できるようにする。
## 完了条件
対象スレッドへ全refの新旧SHAを示す。認可された指示者のDiscord interactionだけを受理する。別人・別メッセージ・期限切れ・停止後・再使用・APIによる自己承認を拒否する。
## スコープ (編集可ディレクトリ)
src/control/push-warning*、src/discord/bot.ts、src/discord/push-warning*、src/api/session-push-check.ts、tools/session-git-hook.mjs、spec。
