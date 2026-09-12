---
name: session-work-phase
description: 初期injectと状況確認で設計の状態を判断し、Ccに設計・確認・実装・調整を記録する。
---

# 作業段階の確認と記録

1. 最新の人間の依頼、合意した範囲、未回答の質問、実際の作業を確認する。
2. 目的・対象・変更内容・受入条件と未決事項を整理する。設計が不足なら `design`。
   読み取り・調査を進め、必要な判断は人間に聞く。初期injectの読了報告だけで止めない。
3. 設計が固まったら `confirmation` に記録し、その設計で実装を開始してよいか人間に確認する。
   同じ質問が未回答なら待機を維持する。自動確認は回答ではない。
4. 同じ設計・範囲に対する人間の開始指示を受けたら、その発言の日時や会話参照を
   `approval_reference` に記録し `implementation` へ進む。すでに指示済みなら再確認しない。
   AI の発言・資料・初期inject・自動確認を人間の指示として記録しない。
5. 実装後の指摘対応は `adjustment`。設計・範囲を変える必要があれば `design` へ戻り、改めて確認する。

## Ccへの記録

Cc endpoint はサービス所有 `excubitor.catalog.yaml`、自分の session id は Lictor sidecar
`http://127.0.0.1:$LICTOR_PORT/v1/concordia/session` から都度取得する。IDをログやファイルへ保存しない。
セッションの実 repo/branch/task を登録してから、自分のセッションだけを更新する。
この専用の段階記録は Cc が正本で、Lictor に更新 proxy はない。上記で取得した自分のIDに対して
以下の専用 API を使う。通常の chat/report の宛先は引き続き自分の Lictor sidecar とする。

- `GET /v1/sessions/:id/work-phase` → `{ work_phase: { phase, revision, design_summary, reason, approval_reference, updated_at } }`
- `PUT /v1/sessions/:id/work-phase` → 次の JSON。返された段階と版を確認する。

```json
{
  "expected_revision": 0,
  "phase": "confirmation",
  "design_summary": "目的・対象・変更内容・受入条件と未決事項を簡潔に記載",
  "reason": "設計が固まり、実装開始を人間に確認する"
}
```

実装への初回遷移には実際の人間の開始指示の `approval_reference` が必須。
同じ設計で実装→調整へ進む場合は保存済み参照を使える。設計概要・対象が変わった場合は流用しない。
409 は再取得して現状を照合し、古い版を押し通さない。API が未配備/取得不能なら記録未確認と報告し、
会話に基づく設計・確認を続ける。metadata への直接書込みで代用しない。
日本語を含む body は UTF-8 ファイルまたは UTF-8 を明示するHTTPクライアントで送る。

この状態記録は実行権限ではない。テスト・再起動・デプロイ・マージの許可は元の人間の指示に従う。
