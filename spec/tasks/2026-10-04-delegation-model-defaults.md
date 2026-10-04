---
task: actio:18d1f5d6-eeb0-496f-8ef5-551bd48954da
project: Concordia
kind: 実装
created: 2026-10-04
memory_links: []
---

# Delegation のモデル名と effort 既定値

neco の開始指示: Sol は名前に6-1、既定medium、xhighの別テンプレートを削除。
Sonnet は5.5にする。最後の訂正で effort は基本すべて可変であり、movable 表記を外す。

価値 UX-CC-AD-W1。既存 agent-delegation が標準プロファイル判断を所有し、
DelegationRepo がテンプレート状態・ID・編集済み本文・モデル追随を所有する。
seed は更新手順、呼び出し名の解決は純粋なポリシー、SQL は repo adapter に置く。
新しい業務ドメインは追加しない。

受入条件: sol-6-1 が medium で1本、sol-xhighは選択不可、Sonnet5.5、
標準テンプレートのmovable名と表示を廃止、effort変更入口を維持。
名前の移行で既存ID・編集済みprompt・モデルpin・run履歴を失わず、再seedが冪等。
旧呼び出し名を標準名へ解決し、名前衝突は上書きせず理由付きで停止する。

PfはConcordia登録を確認したがspecs取得403、仕様版は未確認。
Anatomia plan --no-llm は agent-delegation に所属、hash fcd2fc8a669b50f3。
ローカルテスト・起動・再起動は未許可。Revisor登録検証で審査し、マージまで継続する。
復旧はtemplate IDを照合した上で名前を戻す。編集済み本文やrun履歴を再作成しない。
