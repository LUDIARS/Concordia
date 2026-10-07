---
type: feature
title: 主要 Inject 文面の編集と適用
service: concordia
domain: session-coordination
status: implementation
owner: Concordia
updated: 2026-09-27
---

# 主要 Inject 文面の編集と適用

## 価値と状態

UX-CC-W1/W4/W5、CC-INV-01/04、CC-NODE-01/02。管理者はワークフロー、ケース、編集対象の固定 catalog から主要な案内文を選び、現行内容・版・出典・適用時点を確認して編集する。Cc が所有する人間指示と Actio task の対応を案内の中心とし、session の作業段階を task 状態の代用にしない。保存した文面は次の該当 Inject で実際に使う。

## 不変条件

- 編集対象は固定 catalog の builder 文面、既存 `inject_manuals` 行、既存 delegation template の `prompt_template`、および実際の主 Inject が参照する rule/session-work.md、rule/shared-context.md、skills/session-work-phase/SKILL.md、skills/session-followup/SKILL.md に限る。任意パスや権限条件は編集させない。
- 実行時の branch/path/session ID、対象同定、権限判定、requirements の真偽値はコードが所有する。自然文の変更でこれらを変えない。
- builder は注入された resolver/snapshot で文面を選ぶ純粋な組立てとする。DB グローバル変数を読まない。
- GET は内容と出典と revision を返す。PUT と既定復旧は `expected_revision` を必須とし、現行版との差は 409 と現在の全文で返す。最大 32 KiB を UTF-8 バイト数で判定する。
- `[[CC:name]]` 形式の許可 placeholder のみ受理する。必須 placeholder が欠けた文面は保存しない。未解決の placeholder を実際の Inject に残さない。
- ファイル保存は allowlist と実体パスを検証し、リンクから root 外へ逃げられないようにして atomic replace する。
- ファイル保存は Cc 同士の lock と rename 直前の版照合で競合を抑止する。lock を共有しない外部エディタが照合と rename のごく短い間に書き込む場合まで、ファイルシステムの原子的 CAS は保証しない。
- `inject_manuals` と delegation template は既存 DB を正本とし、同じ本文の複製を作らない。seed はユーザーが編集した template 本文を再起動時に上書きしない。
- 編集本文と seed 保護の保存表は凍結済み baseline migration を変更せず、末尾の番号付き migration で追加する。既存 migration checksum を保持する。
- 保存の受理と既存セッションへの反映は区別する。次回の startup policy、次回のセッション開始、次回の委託起動、次回のファイル読取という適用範囲を返す。

## 対象と受け入れ

`session.work_policy`、`session.process_guidance`、`session.shared_startup_context`、`session.workflow.normal`、`session.workflow.escalation`、`delegation.persona_context`、`delegation.implementation_inject`、`delegation.parttimer_inject` を主要 builder とする。既存 kind マニュアルと個別 delegation template も catalog に表示する。機械的条件と可変文面を分離し、core/backend、chat worker、workflow worker、sessions lifecycle の各実呼出を接続する。

`GET /v1/admin/inject-sources` は軽量 catalog、`GET /v1/admin/inject-sources/:id` は全文・revision、`PUT` は版付き更新、`POST /:id/restore` は版付き既定復旧を返す。未知対象は 404、不正な placeholder は 400、版競合は 409 とする。画面は編集中の下書きを対象切替時にも保持し、保存・競合・適用時点を表示する。

DDD 利用時の成果報告は実装が属した domain をコードブロックで強調し、価値 ID、specRefs、責務、実施/未実施検証を示す。core でない支援境界を core と呼ばない。Goal & Go の終了範囲と Actio task 状態は現行の実制御と一致させる。

検証はテストコードを作成し、型検査・ビルドを行う。単体・統合・起動テストは依頼の許可範囲外なので実行しない。

## 文面の版履歴

人間が調整した文面を失わないよう、固定 catalog の各対象に append-only の版履歴を持つ。本文、対象 ID、直前版 ID、本文 revision、日時、取得できる actor、変更種別を記録する。管理 API は現状、個人を認証・特定できないため actor は `unknown` とし、リクエスト本文や任意 header の自己申告から編集者を推測しない。コードが確実に起点となる移行だけ `system` とする。既存版は更新・削除しない。既定復旧と過去版復元も新しい版を追加する。

通常の `GET /:id` は従来どおり読み取り専用。初めて履歴を開く `GET /:id/history` と最初の更新・復旧の直前に、その時点の実際の正本を `baseline` として保存する。過去の編集日時・編集者は復元できないため、この初期版の時刻は「履歴への取り込み時刻」と明示する。既存手動編集・一時保全 JSON を既定文で上書きせず、一時ファイルを業務上の履歴正本にも使わない。履歴外の変更を後で観測した場合は、取得できた現在値だけを `external_import` として記録し、見ていない中間版や編集者を捏造しない。

WebUI は対象を初めて開くとき、履歴 GET で baseline を作ってから本文 GET を行い、取得した版 ID を最初の保存から CAS 条件へ含める。通常の本文 GET 自体には副作用を増やさない。履歴初期化に失敗した対象は編集可能な本文として扱わない。

起動時の delegation seed では、現在の planned 本文と一致する行はそのまま扱う。既知の旧定型 3 行 block を正確に 1 回だけ除去すると新 planned 本文に一致する行だけ、旧本文を baseline、新本文を `context_migration` として保存する。どちらにも一致しない未マーク行は人間編集の可能性があるため、現在値を baseline に取り込み seed 編集マークを付け、後続の upsert で本文を保持する。出自や旧編集時刻を推測しない。

SQLite 本文の更新は baseline 記録・正本更新・新版本文の追記を同一 transaction に入れる。版履歴の行は追記専用とし、ファイル操作の途中状態は別の journal 表に置く。ファイルは既存 allowlist、リンク検査、lock、expected revision、atomic rename を維持するが、SQLite とファイルシステムを同時に原子化したとは扱わない。rename 前に操作 ID・親版・新旧 revision・新本文を `pending` journal として永続化し、rename 成功後に新版本文を追記して journal を `applied` にする。途中失敗・再起動後は現ファイルの内容と操作 metadata を照合し、成功と断定できない場合は `uncertain` と表示する。結果不明の操作を盲目的に再送せず、解決まで次の同対象更新を止める。管理者が現ファイル・操作 ID・revision・版を照合して明示採用した場合だけ、新しい `resolve_file_outcome` 版を追記し、旧操作を `resolved` と記録して再編集を開く。これは旧操作の成功を推定せず、ファイルを書き戻さない。生きた lock があれば採用を拒む。内容が現行版と同じ通常の PUT は新しい版を作らず、現在版を返す。既定復旧は同文面でも override を削除して既定追従へ戻し、過去版復元とともに新しい履歴版を追加する。

DB 正本が履歴の直近版と異なる状態で保存・復旧を試みた場合、観測した現在値の `external_import` を transaction 内で確定してから 409 を返す。409 の `source` はその取込版 ID を含み、利用者は最新版を採用または再読込してから保存を再試行できる。競合を例外として transaction 内から投げ、取込を rollback して古い版 ID を返してはならない。

`GET /:id/history` は件数制限と cursor 付きの版一覧、`GET /:id/history/:version` は版の本文と親版、`POST /:id/history/:version/restore` は `expected_revision` 付きの過去版復元を返す。既存 `PUT /:id` と `POST /:id/restore` も同じ履歴を追加する。409 は現行全文を返し、WebUI は未保存下書きを保持する。履歴画面は版を選び、親版との差分を表示し、過去版の復元を明示操作にする。復元内容は現在の placeholder と 32 KiB 制限で再検証し、保存後の適用時点を再表示する。

スキーマは既存 migration 112 を変更せず 113 を末尾に追加し、凍結台帳に 113 の checksum と新しい schema fingerprint を追記する。履歴取得・復元・file pending 復旧、既存編集の初期版保存と競合を回帰テストに記述する。実テストとサービス操作は行わない。

## AI セッションからの調整コマンド

AI セッションは WebUI の代わりに、Cc 本体のビルド済み `dist/control/inject-source-apply.js` を絶対パスで呼び、`get` / `history` / `apply` で文面を調整する。Cc は dist 実行なので反映済みの本体ビルドを使い、作業ディレクトリに依存させない。管理 API への任意の書込み権限を与えず、許可ルールはこのコマンドだけに絞る。

- 接続先は `CONCORDIA_URL`、無ければ Cc が配る `CONCORDIA_HOST` / `CONCORDIA_PORT` から決める。ポートを既定値で埋めない。どれも無ければ失敗する。
- `get` は現在の全文を標準出力 (または `--out`) へ、id・revision・版 ID・適用時点を標準エラーへ出す。
- `history` は `GET /:id/history` の版一覧 (版 ID・親版・変更種別・actor・日時・revision) を出す。
- `apply` は `--file` の本文と `--expected-revision` (直前に `get` で読んだ revision) を必須とする。WebUI と同じく履歴 GET で baseline を作ってから本文 GET を行い、その revision と版 ID を CAS 条件に入れて `PUT` する。読んだ revision と現在値が違えば送らずに失敗する。409 は現在の revision を示して失敗し、自動再送しない。
- 変更履歴は既存の DB 版履歴 (append-only) が正本で、コマンド経由の更新も同じ履歴に版として残る。
