---
name: cc-feature-investigation
description: 機能の仕様・実装場所・実装済み範囲を調べる際に、PraeformaとAnatomiaを照合して根拠を残す。対象機能の調査に使う。
---

# 機能調査

対象repo/branchと機能名をCcのbindingから確定する。Pf/Anは調査ツールであり、編集対象をそのrepoへ切り替える指示ではない。

1. Praeforma（Pf）の対象projectで仕様・UX・仕様版を確認し、該当する仕様IDと正本への参照を残す。仕様上の予定、承認、実装状況を分ける。
2. Anatomiaの同じprojectで `context --project <registered-name> --task <question>` を使い、実装箇所・依存・既存ドメインを絞る。実装計画も依頼されている場合は `plan --project <registered-name> --task <task> --no-llm` を先に使う。CLI入口はworkspaceの `Anatomia/bin/anatomia.mjs`。登録名はproject listで確認し、repo名から推測しない。
3. 返された対象ファイルと仕様の正本を読み、仕様ID・実装path・確認したrevisionを対応付ける。「仕様にある」「実装にある」「動作確認した」「不明」を分けて答える。

Pf/Anのendpointはそれぞれのサービス所有 `excubitor.catalog.yaml` から解決する。利用可能な接続ツールか現行APIを使う。停止中なら勝手に起動せず、対象repoの `spec/ux`、`spec/feature` と対象ソースへ限定して調査を続け、未取得の根拠を記す。一般的な文書校正だけには適用しない。

調査後の実装も依頼済みならそのまま続ける。このスキルの「調査」を理由に実装依頼を相談へ戻さない。

Pfに対象プロジェクトが未登録なら、登録を自動作成せず従来のrepo内仕様・コード検索へ進む。未登録と接続障害は別に記録する。
