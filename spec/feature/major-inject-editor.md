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
