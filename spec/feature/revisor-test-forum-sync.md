---
title: "Revisor Test Workflow synchronization"
status: implemented
service: concordia
domain: release-coordination
updated: 2026-09-12
---

# Revisor Test Workflow synchronization

## Purpose

CcのDiscord Test Forumは、Revisorに登録された時点のローカルPRを掲載する
(審査中・失敗・判断待ちも全部)。GitHub PR台帳は候補の正本にしない。
投稿は審査レポートを読む場所とする。PR 本文、審査の開始、各チェックの実行・結果・
スキップ理由、レビュー内容、最終判断を Discord 内で読めるようにする。
既存の明示的なテスト開始・マージ操作面 (spec/feature/test-forum-controls.md) は補助機能。

## Source and lifecycle

- CcはExcubitor catalogでRevisorの稼働ポートを解決し、loopback read APIの
  `/v1/local-prs?state=open` と `/v1/repositories` を併読して **open な local PR 全件** を
  候補にする (checkStatus は問わない)。ポートは設定やソースへ固定しない。
  終局投稿に使う決着済み PR は `/v1/local-prs?view=summary` (リポ・番号・状態・
  `mergeCommitSha`・id・`reviewReportVersion`) で読み、全件・全フィールドの一覧は取らない。
  同期の間に終了した新形式の未掲載 PR は、軽量一覧の version を手掛かりに個別詳細を
  取得してレポートを掲載する。閉鎖済みを含む掲載台帳で同じ PR の再掲載を防ぐ。
- 各行の decision (判定・判断事項 blockers・マージリスク・テスト結果・
  セキュリティスキャン・動作確認要否) と checkStatus を投稿本文に描画する。
  `failed` と、decision が `failed` と分類した `action_required` では、worker error、
  失敗テスト名・exit code・理由・Revisor 側で秘匿値をマスク済みの出力も掲載する。
  客観的な失敗を「人間の判断が必要」と読み替えない。
  確認sessionを安全に起動できるよう、local PRのhead refとRevisor登録済み
  repository rootを結合する。骨格 (id/repository/番号/head/rootPath) が欠けた
  行は候補から外す。
- 読取はloopback限定でRevisor側がtokenを要求しない。設定画面から DB に workflow token が
  保存されている場合だけBearerとして送り、未設定でも同期は動く。旧 env は読まない。
- 新規掲載時、提出セッション (`sessionId`) の session_events から
  **操作していたDiscordユーザ全員** を解決し、スレッドへメンション付き
  メッセージを1回だけ投げる (starter本文は常にメンション抑制)。
- 候補は描画元データの指紋 (content hash) を持つ。**内容 (head SHA・タイトル・
  checkStatus・詳細) が変わった場合は投稿を閉じず、スターターメッセージの
  編集でリフレッシュする**。指紋が一致する限りDiscordへ編集を投げない (rate limit保護)。
- checkStatus の待機・開始・決着遷移 (→ queued / running / test_ok / failed / action_required) は、
  スレッドへ通常メッセージで知らせる。失敗遷移はその時点の詳細証跡を載せ、
  Test OK 遷移は審査詳細へ案内し、マージ可能な場合は既存の権限付き操作を表示する。
- 操作面 (provider/effort セレクタ + テスト開始 / マージ) は **Test OK かつ Revisor が
  mergeable と判定した候補だけ**に付ける (spec/feature/test-forum-controls.md)。
  審査前・失敗・判断待ち・draft の候補には
  出さない。
- repository rootまたはhead refが変わった場合は、安全なspawn targetを更新するため
  旧投稿を閉じて現在の候補を作り直す。
- 終局状態を確認できた候補は、最終詳細を取得・掲載してから投稿を閉じ、関連するテストセッションも終わらせる。
  終局一覧で **merged** と確認できる場合は、archive 前に「マージしました」と
  統合コミットをスレッドへ通常メッセージで残す。終局一覧・個別詳細・投稿が失敗した場合は
  開いたまま保持し、次周期に再試行する。
- Revisorへの接続または応答検証に失敗した場合は同期全体を失敗として扱い、
  既存投稿を一括で閉じない。
- Discord側の失敗 (自動archive・権限・rate limit) は投稿1件の範囲に閉じ込め、
  その周期の他の投稿の作成・更新・クローズを巻き添えにしない。失敗した投稿は
  DBを書き戻さないので次の周期で再試行する。掲載継続中の投稿がarchiveされて
  いた場合は、編集の前にarchiveを解除する。

## Detailed review reports

> ### SPEC-DISCORD-REVIEW-REPORT: 詳細審査レポートの配送

- Revisor の `reviewReport` v1 は attemptId、headSha、安定した id を持つ entries
  (kind / label / status / at / content) を正本とする。Cc は実行時刻や結果を捏造しない。
- PR 本文と各履歴を個別投稿にする。長い本文はプレビューと UTF-8 テキスト添付で
  全文を保持し、大きい文書は Unicode 文字を壊さず分割する。秘密値は再度マスクし、
  本文・添付からのメンション通知を抑制する。
- 旧 Revisor で履歴が無い場合はその制限を明記し、取得できたチェック結果・出力を掲載する。
  不正な v1 履歴は未取得扱いで黙って捨てず、読取エラーとする。
- PR、履歴 id、内容の指紋を Bot の投稿に受領印として付ける。再試行前に同じ Bot の
  投稿履歴を読み、配送済みの本文を再送しない。履歴読取失敗は送信を止める。
  レポート配送の完了後にだけ台帳の content hash を進める。

## テストセッションとスレッド投稿

- テストセッションは操作面の「テスト開始」ボタンで明示的に起動する。
  レポート掲載と普通のコメント投稿では起動しない。
- スレッドに人間が投稿したとき:
  - surface の `session_id` が生きていれば、投稿本文を inject で届ける (📨)。
  - 生きた session が無ければ普通のフォーラムコメントとして扱い、起動しない。
- Test Forum session は検証と報告だけを担当する。Revisor の workflow token は委譲せず、
  提出・再審査・マージ・クローズなどの状態変更を session に実行させない。
  人間の明示 merge は Cc の権限付き構造化操作、オートマージは Revisor の状態機械が
  処理する。同一スレッドの自然言語は検証 session への指示であって mutation command
  には変換しない。
- 起動プロンプトには、対応を始める前に紐づいた TestWorkflow フォーラムの既存投稿
  (審査失敗理由・エラーログ・失敗テストを含む) を読むよう明記する。
- テストセッションは end-session で終了できるが、**投稿はクローズしない**。
  投稿を閉じるのは同期 (候補消滅) だけ。
- 候補がマージ等で消えて投稿を閉じるとき、旧経路の `qa_run_id` の child session と
  操作面経由の `session_id` の両方を `DELETE /v1/sessions/:id` で終わらせる。
  既に終了済みなら no-op として扱う。

## Runtime boundary

Revisor Test Workflowの読取クライアントはDiscord表示処理から分離する。
接続は読取専用で、local workflow tokenが設定されている場合のみBearer送信する。
workflow token は Cc サービス内に留め、interactive session の inherited env と明示 env
のどちらからも除去する。
一覧のレスポンス形式が不正な場合は項目を黙って捨てずfail-fastする。
詳細は追加情報のため、欠落フィールドはnullへ落とすが、骨格 (object) が無い場合は
そのPRの詳細をエラーとして扱う。
spawn targetを結合できない場合、その行は候補から外す。repository rootは
Revisor登録値のみを信頼し、Discord入力から組み立てない。

一覧系の読取 (`/v1/test-workflow` `/v1/local-prs?state=open`
`/v1/local-prs?view=summary` `/v1/repositories` と Excubitor catalog 引き) は、
query 込みの path ごとに短いTTLとsingle-flightで1回に畳む。Discord client
(本社・子会社) は読取クライアントを共有し、1回のreconcile roundで同じ一覧を
複数回取得しない。一覧をclient数×呼出箇所数だけパースすると、その全部が
メインスレッドに乗ってevent loopを止めるため。絞り込みなしの `/v1/local-prs` は
解析結果込みで 100MB を超えたことがあり (1,685 件で 142MB)、取得とパースだけで
秒単位で止まるので、Test Forum の同期では使わない。取得失敗はキャッシュせず、待ち合わせ中の
全呼出へ同じerrorを伝播させる (空一覧へ落とさない)。PR状態変化の通知など即時性が要る
契機では、キャッシュを明示的に捨ててから取り直す。定期reconcileは取りこぼしを拾う
整合スイープと位置づけ、掲載の即時性はイベント契機が担う。同じ変更イベントを共有する
複数のDiscord runtimeからの無効化は1回に畳み、開始済みsingle-flightを相互に破棄しない。
