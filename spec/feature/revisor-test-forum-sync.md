---
title: "Revisor Test Workflow synchronization"
status: implemented
service: concordia
domain: release-coordination
updated: 2026-08-04
---

# Revisor Test Workflow synchronization

## Purpose

CcのDiscord Test Forumは、RevisorのローカルPR審査を通過した
`Open / Test OK` のプロダクトだけを掲載する。GitHub PR台帳は候補の正本にしない。
投稿にはPRの詳細と判断事項を載せ、テスト・QAセッションの起点にする。

## Source and lifecycle

- CcはExcubitor catalogでRevisorの稼働ポートを解決し、
  `GET /v1/test-workflow` を読む。ポートは設定やソースへ固定しない。
- 各プロダクトについて `GET /v1/local-prs/:id` で詳細 (判定・判断事項 blockers・
  マージリスク・テスト結果・セキュリティスキャン・動作確認要否) を読む。
  詳細の取得失敗はそのPRの掲載を骨格情報だけに落とし、同期全体は止めない。
- 読取はloopback限定でRevisor側がtokenを要求しないため、`CONCORDIA_REVISOR_WORKFLOW_TOKEN`
  は任意とする。設定されている場合だけBearerとして送る (未設定でも同期は動く)。
- Revisorが返すrepository、local PR番号、タイトル、reviewed head SHA、詳細から
  Test Forum候補を作る。確認sessionを安全に起動できるよう、同じloopback read APIの
  `/v1/local-prs` と `/v1/repositories` を併読し、local PRのhead refとRevisor登録済み
  repository rootを `pullRequestId` / `repository` で結合する。候補は描画元データの
  指紋 (content hash) を持つ。
- 同じrepository・PR番号の投稿は維持する。**内容 (head SHA・タイトル・詳細) が
  変わった場合は投稿を閉じず、スターターメッセージの編集でリフレッシュする**。
  指紋が一致する限りDiscordへ編集を投げない (rate limit保護)。
- repository rootまたはhead refが変わった場合は、安全なspawn targetを更新するため
  旧投稿を閉じて現在の候補を作り直す。
- Revisor一覧から消えた候補 (マージ・取り下げ・再審査落ち) は理由を推測せず
  投稿を閉じ、関連するテスト・QAセッションも終わらせる。
- Revisorへの接続または応答検証に失敗した場合は同期全体を失敗として扱い、
  既存投稿を一括で閉じない。
- Discord側の失敗 (自動archive・権限・rate limit) は投稿1件の範囲に閉じ込め、
  その周期の他の投稿の作成・更新・クローズを巻き添えにしない。失敗した投稿は
  DBを書き戻さないので次の周期で再試行する。掲載継続中の投稿がarchiveされて
  いた場合は、編集の前にarchiveを解除する。

## テスト・QA delegation

- 投稿の新規作成 (= テスト候補の検知) を起点に、delegation テンプレート
  `test-qa` (category: `test-qa` = テスト・QA) のセッションを自動起動する。
  仕事は候補内容の確認・調整であり、マージ判断はしない。
- 起動した delegation run id は surface 行 (`qa_run_id`) に記録する。
  起動失敗は投稿の掲載を巻き戻さない (掲載が主・QAは従)。
- QAセッションは end-session で終了できるが、**投稿はクローズしない**。
  投稿を閉じるのは同期 (候補消滅) だけ。
- 候補がマージ等で消えて投稿を閉じるとき、`qa_run_id` の child session を
  `DELETE /v1/sessions/:id` で終わらせる。既に終了済みなら no-op として扱う。

## Runtime boundary

Revisor Test Workflowの読取クライアントはDiscord表示処理から分離する。
接続は読取専用で、local workflow tokenが設定されている場合のみBearer送信する。
一覧のレスポンス形式が不正な場合は項目を黙って捨てずfail-fastする。
詳細は追加情報のため、欠落フィールドはnullへ落とすが、骨格 (object) が無い場合は
そのPRの詳細をエラーとして扱う。
spawn targetを結合できない場合もfail-fastする。repository rootはRevisor登録値のみを
信頼し、Discord入力から組み立てない。
