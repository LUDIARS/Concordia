---
task: work-modes-domains
project: Concordia
kind: 仕様
created: 2026-10-10T00:00:00.000Z
memory_links: []
---
# 作業の進め方をドメインに分けて仕様化する

neco 指示 (2026-10-10): スクラムっぽい動きは今の LUDIARS に合わない。デイリーでゴールを決めて
専用セッションを自走させ、1 時間おきに確認しながら Goal & Go する仕掛けにしたい。やり方が増えたので
ドメインを切ってそれぞれの進め方を仕様に定義する。

## 目的

進め方 (方式) の一覧と選び方の正本を作り、新方式「デイリーゴール自走」を独立 domain として仕様化する。

## 変更内容

- `spec/feature/work-modes.md` + `spec/domains/work-modes.domain.json`: 7 方式の一覧、選び方、方式をまたぐ不変条件。
- `spec/feature/daily-goal-run.md` + `spec/domains/daily-goal-run.domain.json`: デイリーゴール自走の仕様 (計画)。
- `spec/ux/product.md`: 価値 UX-CC-W9・シナリオ UX-CC-S10 (draft)。
- `spec/feature/sprint-dialogues.md`: 休止の注記。
- `spec/README.md`: feature 一覧へ追加。

## 完了条件

- [x] 7 方式すべての起点・ゴールの所有者・確認の周期・完了・正本が書かれている。
- [x] デイリーゴール自走の状態所有者・流れ・予算・不変条件・受入条件が書かれている。
- [x] スプリントの休止と、消さないものが明記されている。
- [ ] Revisor 審査を通りマージされる。

## スコープ外

デイリーゴール自走の実装 (daily-goal-run.md「実装の分割」の 5 単位) は別タスク。
