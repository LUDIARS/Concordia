---
type: feature
title: "Director — 原稿フロー進行と Genius 判断代理"
description: "依頼を原稿フローの工程として管理し、実装の進行管理を Concordia Director、判断を Genius、権限判断を人間へ分離する。"
service: concordia
domain: governance
status: implemented
related:
  - feature/task-workflow.md
  - feature/inquiry.md
  - feature/delegation-coordination.md
  - feature/develop-confirm-flow.md
---

# Director — 原稿フロー進行と Genius 判断代理

## 0. 原則

Director は判断する LLM ではない。ユーザー依頼を原稿フローとして進め、工程ごとの
入力・成果・担当・依存をつなぐ制作進行である。設計、優先順位、採否の判断は Genius
（neco の判断代理）へ問い合わせ、権限・スコープ・破壊的操作を含む未解決事項だけを
人間へ上げる。

Cc は task md、taskflow runtime state、delegation run、PR、confirm run の正本を複製しない。
Director が永続化するのは、それらを束ねる case/step と判断の監査記録だけである。

## 1. 原稿フロー

```
依頼 → 分解 → 委託 → 実装 → レビュー → 確認 → 完了
                  ↑       │         │
                  └──── Director の工程・引継ぎ ────┘
                            │
                        判断依頼
                            ↓
                         Genius
                            ↓
                    proceed / ask_human / self_judge
```

各工程は Director step として、次を持つ。

- 種別: `decompose` / `delegate` / `implement` / `review` / `confirm` / `complete`
- 入力・成果物参照: task md path、delegation run id、local PR id、confirm run id
- 状態: `pending` / `active` / `blocked` / `completed` / `cancelled`
- 次工程へ渡す handoff note

step の状態変更は Director API を通す。実装自体の状態は taskflow/delegation/PR の既存正本から
read model で併記し、Director step に複写しない。

## 2. 判断と実装の分離

実装担当は、曖昧な自由文の質問ではなく Decision Request を Director へ送る。

```jsonc
{
  "kind": "design",             // design | priority | scope | authority
  "question": "D1 未マージ時に D4/D5 をどの base で進めるか",
  "facts": ["D1 PR #293 is open", "D4/D5 depends on session_messages"],
  "options": ["D1 branch を base にする", "D1 merge を待つ"],
  "impact": "作業開始と PR base に影響"
}
```

Director は request と紐付く case/step、事実、選択肢を監査保存して Genius に渡す。
Genius の回答は `proceed`、`ask_human`、`self_judge` のいずれかとして保存し、Director が
その instruction と根拠を担当 session へ引き渡す。Cc は回答内容を生成・補完しない。

- `proceed`: Genius の判断を handoff として次工程へ渡す。
- `ask_human`: 工程を blocked にし、上長への 1 件の判断カードを作る。
- `self_judge`: Genius 不在または前例不足。担当へ「通常判断で進める」を明示する。

ただし `authority` / `scope` は担当セッションへ委ねられない境界なので、Genius が不在でも
`self_judge` へ降格せず `ask_human` として工程を blocked にする。

merge、テスト開始、サービス制御、push、破壊的操作は Director の action 対象外であり、
既存の人間承認・Revisor・Excubitor 経路を維持する。

## 3. データモデル

`director_cases` は依頼単位。title、goal、project、created/updated 時刻を持つ。
`director_steps` は case 内の順序と工程情報、成果物参照、handoff note を持つ。
`director_decisions` は step に紐づく判断依頼、Genius の可用性、決定、instruction、根拠カード、
人間 escalation の有無と、同一時刻でも発生順を保持する単調増加の監査順序キーを持つ。

いずれも taskflow の status、assignee、PR 番号を所有しない。task md は static definition、
taskflow state は runtime state、delegation/PR/confirm は既存テーブルが唯一の正本である。

## 4. 初期縦切り

1. case/step/decision の SQLite migration と repository。
2. case/step の作成・参照 API。
3. decision request の監査保存と Genius client 呼出し。既存 inquiry の `GeniusClient` と
   decision vocabulary を再利用する。
4. case read model と API テスト。

委託の自動起動、step の自動進行、Discord UI、PR/confirm への書込みは後続工程とする。
