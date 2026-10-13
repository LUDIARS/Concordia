---
task: repost-request-on-session-start
project: Concordia
kind: 実装
created: 2026-10-13T00:00:00.000Z
memory_links: []
---

# セッション起動時に依頼内容を投稿し直す

## 要件

人間の指示 (2026-10-13): Consult の初回やフォーラムでセッションを起動したとき、相談内容が消えたり分からなくなる。

- フォーラム起動系のセッションでは、タイトルと本文を再投稿する。
- 相談のプライベートチャンネルも、タイトルと相談内容、設定したオプション引数などを最初に投稿する。

## 対象

- 文面: `src/discord/request-recap.ts` (純関数、メンション無害化・2000 文字上限)
- フォーラム起動: `src/discord/forum-spawn.ts` (起動成功時、起動通知の前)
- 相談: `src/discord/consult-flow.ts` (チャンネル作成直後の案内の次)。部署名は `PrivateConsultationService.start` の結果で渡す。
- 仕様: spec/feature/discord-forum-migration.md (Session フォーラム起動 8.)、spec/feature/tech-consultation.md §4

## 完了条件

- 両経路で依頼内容が 1 通で投稿され、メンションが鳴らない。
- 登録テストが回帰しない。
- Cc の build と再起動後、実際のフォーラム投稿・相談で投稿されることを確認する。
