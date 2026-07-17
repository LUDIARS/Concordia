---
task: fix-ask-question-answer-path
project: Concordia
kind: 実装
status: pending
created: 2026-07-17T00:00:00.000Z
source_session: lictor-340dbfff-25a8-4bd0-9a66-8ba0a0ceb69e
memoria_task_id: 540
actio_task_id: null
memory_links: []
---
# AskUserQuestion 回答経路のエラー修正と回帰テスト

## 目的

neco 指示 (2026-07-17):「AskUserQuestion がエラーで帰るエラーの調査対応と回帰テストの作成」。

調査結果 (cc-live.jsonl 実ログ):
- `interaction handler failed custom_id=q:1147:0 age_ms=1127: fetch failed` (2026-07-13,
  同一ボタンで 5 連続失敗)。embedded Discord bot が回答を **自分自身への HTTP
  (127.0.0.1:11111 /answer-question) self-fetch** で送っており、イベントループ詰まりで
  accept backlog が溢れると自プロセスへの fetch すら ECONNREFUSED で落ちる。
  さらに fetch 例外がハンドラ外へ escape し、ユーザへの応答も出ない。
- `interaction handler failed ... age_ms=7640〜41438: Unknown interaction` —
  イベントループ停止中に処理が遅延し Discord の 3 秒 ACK 期限が切れた事例
  (これは詰まり根治 = full-async 側の守備範囲)。

## 対応

1. 回答処理のコアを `src/control/answer-question.ts` に抽出 (repos + eventBus を受ける純関数)。
   HTTP ルート `/v1/sessions/:id/answer-question` (api/sessions/qa.ts) はコアを呼ぶだけにする。
2. embedded Discord bot は self-fetch せず **in-process でコアを直接呼ぶ**
   (DiscordBotDeps に answerQuestion 依存を追加、bootstrap 側で注入)。
3. chat-worker (別プロセス) は従来どおり HTTP だが、**リトライ (2 回, 300ms backoff) +
   例外を握って「Answer failed: ...」をユーザに返す** graceful 化。
4. fetch 例外が dispatchQuestionInteraction の外へ escape しないこと。

## 完了条件

- 回帰テスト: コア関数 (単一/複数/自由文/範囲外/回答済み/不存在)、
  in-process 経路が fetch を使わないこと、HTTP fallback のリトライと graceful 失敗。
- tsc + vitest 緑。

## スコープ (編集可ディレクトリ)

- src/control/ src/api/sessions/ src/discord/ src/bootstrap/ src/chat-worker.ts tests/
