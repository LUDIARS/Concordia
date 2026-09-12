---
title: セッションの設計・開始確認・実装・調整
id: CC-SESSION-WORK-PHASES
type: feature
service: concordia
domain: session-coordination
status: draft
---

# セッションの設計・開始確認・実装・調整

2026-09-12 neco 指示: 初期 inject で止まらず、設計が固まったら人間に開始を確認して
実装へ進む。放置セッションの状況確認時にも設計の状態を判断する。
UX-CC-W1/W4、UX-CC-S1/S5、CC-INV-01/04/08 に対応する。

## 所有と用語

Cc がセッション単位の作業段階を所有する。プロセスの active/lost/ended、task の完了、
Revisor の審査状態とは独立。`sessions.metadata.cc_work_phase` に記録し、既存 DB の
原子的 metadata 更新を使う。新規テーブル・外部サービス・timer は追加しない。

| 段階 | 意味 | 次の行動 |
|---|---|---|
| design / 設計 | 目的・対象・変更内容・受入条件を整理中 | 不足を調査し、判断が必要なら人間へ確認 |
| confirmation / 確認 | 設計が固まり、実装開始の人間確認待ち | 決まった範囲を示して開始確認。無応答で解除しない |
| implementation / 実装 | その設計に対する開始指示を確認済み | 許可された範囲を実装 |
| adjustment / 調整 | 実装後の指摘・結果に応じた調整 | 同じ合意範囲の修正。範囲が変われば設計へ戻る |
| unknown / 未確認 | 既存セッションの未記録、破損、対象変更 | 会話と現状を確認して段階を記録。承認を推測しない |

設計が固まったとは、目的・対象・変更内容・受入条件と未決事項を説明でき、着手を
妨げる判断が残っていないこと。単なる経過時間・タスク存在・初期 inject の配達では判断しない。
設計概要と人間の開始指示への参照を記録する。会話上ですでに同じ範囲の開始指示を
受けている場合はその参照を使い、重ねて確認しない。自動確認・資料・AI 発言は開始指示ではない。

## 境界と不変条件

- 純粋な段階判断・型: `src/work/session-work-phase.ts` (session-coordination)。
- 更新手順: `src/work/update-session-work-phase.ts` (session-coordination)。
- 保存: 既存 `SessionsRepo.updateMetadata` (session-lifecycle)、API: `src/api/sessions/work-phase.ts`
  (session-lifecycle)。既存 API の metadata パッチから専用キーは変更できない。
- src と対応する test の所属を同じ pathPattern で宣言する。初回提出は型検査のみ。
  PR #1709 の登録テスト所見を受け、Revisor の検証計画に基づいて段階判断・API 保存・
  定期案内の回帰テストを追加する。
- Web UI は session-message-webui、Discord 状態カードと読み取り型は chat-platforms、
  `src/api/chat-read-models.ts` は http-interface。初期案内は session-coordination、巡回は autonomous-continuation。
- revision の一致を原子的更新内で確認する。競合は 409、再取得して判断し直す。
- repo/branch/task の変更で以前の設計・開始確認を現対象へ流用しない。古い記録は残し、
  表示・巡回では未確認とする。元の対象へ戻った場合は同じ記録を参照できる。
- 設計を変えると以前の開始指示を引き継がない。実装/調整には設計概要と開始指示参照が必要。
  調整へ進むには同じ設計・対象で実装開始の記録が必要。
- これは会話で確認した作業状態の申告であり、Git/サービス操作の権限を発行する API ではない。
  参照文面を人間の発言として独立に認証する機能は持たない。実行許可は元の人間の指示が正本。
- DB 更新と監査イベントを同一 transaction 内で保存する。通知失敗でも GET で保存済み状態を照合する。
- 自動巡回は段階を推測して DB に書かない。AI に設計の再評価を依頼する。未回答質問と
  人間回答待ちの既存抑止を維持し、確認状態から実装への自動遷移はしない。

## API と表示

`GET /v1/sessions/:id/work-phase` で `{ work_phase }` を取得。
`PUT /v1/sessions/:id/work-phase` に `expected_revision`, `phase`, `design_summary`, `reason`,
必要時 `approval_reference` を送る。approval_reference は人間の発言日時・会話参照などであり秘密を含めない。
更新済み状態を返し、`session.event` の `work_phase_changed` で表示を更新する。
新規セッションは設計から開始し、既存の未記録セッションは未確認と表示する。
セッション一覧・チャット作業パネルで段階と設計概要を読める。Discord 状態カードにも段階を表示する。

## 調査根拠と検証条件

- 基点 main: `426dd783afc78c7c3b137b5c0b7cd570c3f9b402`。
- Pf: project `01M1XZZMEXWTFCN4HKW8K7TJKM` / Anatomia `concordia`、UX revision 0。
  specs 一覧は空。正本は `spec/ux/product.md`、`spec/ux/session-coordination.md`。
  Pf に機能の承認済み版を新設しない。
- Anatomia `plan --project concordia --no-llm`: autonomous-continuation / taskflow-instructions を
  既存候補として検出。cache 保存 EPERM、解析結果取得済み。ソースを照合し状態所有を上記へ限定。
- 回帰条件: 未記録の設計評価、設計→確認、未承認の実装拒否、既存開始指示の再利用、
  設計・対象変更時の承認非流用、競合の 409、metadata キーの保護、巡回の人間待ち維持、
  PR 状態と段階の併存、初期 inject の開始確認案内、画面の取得失敗表示。
- バックエンド (`tsconfig.json` / `tsconfig.test.json`) と Web (`web/tsconfig.json`) の型検査に成功。
  初回提出時の単体・統合・起動・ブラウザテストは未実施。
- PR #1709 の指摘対応: 定期案内と公開API一覧の期待値を更新し、状態遷移とAPI保存の回帰検証を追加。
  Revisor 検証計画に基づく関連8ファイル・79 tests が成功。実行前後の testing claim/release を確認。
  `tsconfig.test.json` の型検査にも成功。サービスの起動・再起動、ブラウザ確認、本体反映は未実施。
- 実差分を入力した Anatomia verify の spec_linkage は成功。全体判定には coupling_delta の所見が
  残る（coupling 23/17、閾値16）。この修正はテスト・仕様参照のみで実行処理を変更していない。
  Revisor の再審査結果と独立した単体解析結果として扱い、全ゲート通過とは報告しない。
