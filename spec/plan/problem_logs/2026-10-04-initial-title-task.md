# 初回タイトル変更タスクの誤作動報告

necoより「Ccの最初Lictorにタスク投げるやつがたまに誤作動するので、タイトル変えるタスク投げなくていい」と報告・開始指示を受けた。具体的な誤作動ログと実機再現は未取得。

確認した送信元は src/stat/repo-change-watcher.ts。初回stat、repo変更、promptでtitle-suggestをenqueueしていた。タスク投入を廃止し、作業名表示の既存イベントは保持する。ローカルテストと起動操作は行わない。

対応 Actio: dd7ed382-4134-4a0f-a1df-b4b89bac8b9c。Anatomia決定的調査hash e25f8376c113c9a5。spec/ux/observability.mdは存在しないため読了とは扱わず、既存domain定義とsession-coordination UXの価値・既存relay仕様を確認した。
