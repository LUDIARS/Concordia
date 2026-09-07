---
task: auto-apply-context-compaction
project: Concordia
kind: 実装
created: 2026-09-07
memory_links:
  - spec/tasks/2026-09-07-detect-provider-context-capacity.md
---

# 検知したコンテキストに基づきco-compactionを自動適用する

## 目的

necoの自動適用指示に基づき、既存の引き継ぎ投稿→履歴消去→再投入を改善する。Discordとtranscript_logsに原文を残し、要点と現在の関心から復帰できるようにする。

## 完了条件

- detect-provider-context-capacityの信頼できる計測値を利用する。固定200kを発火根拠にしない。
- 閾値・引き継ぎ生成の余裕・安全な実行タイミングを仕様化し、provider自身の圧縮と競合させない。
- セッション単位の多重実行防止、圧縮後の新規計測確認、連続発火抑止、失敗時の再試行制御を持つ。
- handoffに要点・現在の関心・未解決事項・制約・作業場所・次の一手・原文参照を残す。
- handoffの永続保存と原文参照を確認してから履歴を消去する。生成・保存失敗時は消去せず原因を記録する。
- providerの消去・再投入能力を確認し、未対応providerへ一律で/clearを送らない。
- 再投入失敗から保存済みhandoffで復帰でき、人間待ちや終了条件を勝手に解除しない。
- 圧縮前後の使用量・キャッシュ利用・処理時間を取得可能な範囲で記録し、未取得を節約と断定しない。
- session-compaction.mdとphase-compaction.mdの手動限定仕様を今回の明示指示に合わせて更新し、手動コマンドと処理・状態所有者を共通化する。

## スコープ (編集可ディレクトリ)

src/control/、src/cost/、src/bootstrap/、src/discord/、関連するAPI・DB境界とspec/。

テスト・起動・再起動は明示許可なしに実行しない。成果と進行状態は別の記録およびCc DBで管理し、このtask mdには書き戻さない。

