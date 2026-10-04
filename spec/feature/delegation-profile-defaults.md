---
type: feature
id: CC-DELEGATION-PROFILE-DEFAULTS
title: Delegation model versions and adjustable effort
domain: agent-delegation
status: draft
---

# Delegation model versions and adjustable effort

neco の2026-10-04開始指示が実装範囲の根拠。UX-CC-AD-W1 に対応する。
Sol は sol-6-1 / gpt-6.1-sol、初期 medium。sol-xhigh の別テンプレートは削除する。
Sonnet は sonnet-5-5 / claude-sonnet-5-5。Opus/Fable は名前の movable を外す。
effort は基本可変であり、起動時値を永久固定値として扱わない。

DP-01: 名前を更新しても既存 ID、編集済み prompt、モデル pin を保持する。
DP-02: 旧呼び出し名は標準名へ解決し、sol-xhigh を互換名として復活させない。
DP-03: 再seedは冪等。名前が衝突したときは既存行を上書きせず停止する。
DP-04: Sidecar は旧 sol-mid の依頼も新標準へ解決し、起動時 medium と既存所有権境界を維持する。

状態所有者は DelegationRepo。呼び出し名ポリシーは純関数、seed は更新ユースケース。
モデルカタログは既存 owner の seed 経路で Sonnet5.5 を追加する。
復旧はIDを照合して名前を戻す。実行履歴や編集済み本文を再作成しない。
ローカル実テスト・起動・再起動未実施。Pf specs は403で仕様版未取得。
この文書は draft であり、実機評価済みやプロダクト承認済みとは扱わない。
