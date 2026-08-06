# Manual Implementation Workflow Churn

- Date: 2026-08-06
- Status: fixed in working tree
- Area: session coordination / Excubitor / Revisor
- Severity: repeated operational waste

## Summary

実装セッションが project code 検索、branch 確認、Cc 登録、testing claim、Excubitor 操作、
Revisor 提出・再提出、終局通知の復旧を都度手組みしていた。決定的な workflow を session の
判断に委ねたため、同じ確認と会話が繰り返される回帰である。

## Evidence

- 2026-08-06 user-visible symptom: Ex restart と Rv submit/resubmit/notification の往復が多すぎる。
- `lictor cli task set` は project code、repo binding、branch を別々に入力する。
- `POST /v1/prs/local` は session id を呼び出し側が取得して渡す必要がある。
- `POST /v1/testing/claim`、Excubitor control、`POST /v1/testing/release` が別操作である。
- `submitSessionLocalPr` は terminal な既存 local PR も `already_open` で止め、再審査は別操作になる。

## Regression Context

Cc には project resolver、testing claim、Revisor local PR、自動終局通知が既にあるが、
session 向けの一つの実装 workflow として結合されていなかった。

## Cause

既存状態への操作が複数requestとskill文書へ分散し、sessionが毎回接続・識別・順序を組み立てていた。

## Fix Requirements

- 実装作業だけが明示的に opt-in する。
- 状態は既存のConcordia session/testing claims/Revisor PRを使い、新しい状態機械を作らない。
- project code と git binding を cwd から自動解決する。
- testing claim / Excubitor control / release を finally-safe な一遷移にする。
- terminal local PR は同じ submit 操作で Revisor retry へ進める。
- Revisor通知は既存session bindingを使い、agent側ではpollingしない。

## Verification

Revisor が typecheck、unit test、API contract test を実行する。session 自身はユーザー指示が
ないため test・起動確認を実行しない。

## Follow-up

Lictor CLI の実装 workflow command を配布し、既存 skill の手動 curl 手順を廃止する。
