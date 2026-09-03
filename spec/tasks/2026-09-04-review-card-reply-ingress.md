---
task: review-card-reply-ingress
project: Concordia
kind: 実装
created: 2026-09-04
memory_links:
  - spec/tasks/2026-09-04-team-card-kinds-review-delay-adjust.md
---
# `review` カードの番号返信を Actio へ取り込む

## 目的

Actio `spec/feature/team-task/spec.md` §10「Cc 側変更 4」。
判定キューは `review` カード (direction 面) に番号付きで提示される。人間はカードへ
番号で返信して判定するが、その返信を Actio へ届ける経路が無く、判定が Discord 上で
止まってしまう。

定例カードの番号返信と同じ機構で ingress を作り、Actio の
`PATCH review-items` へ変換する。

カード投稿時に Discord の message ID と Actio の review item ID・選択肢番号を永続化し、
返信時はその対応表だけから対象を解決する。カード本文を再解析して対象を推測しない。

## 完了条件

- `review` カードへの番号返信が Actio `PATCH review-items` へ変換されて届く。
- Discord 返信者の platform user ID を Actio の actor 情報へ渡し、Actio の認可拒否を
  成功として扱わない。
- 対象カードが特定できない返信、範囲外の番号、既に判定済みの項目への競合返信は
  取り込まずに理由を返す (誤った項目を判定しない)。
- Discord message ID を冪等キーとして永続化し、同じ返信の再配信・bot 再起動で
  二重に PATCH しない。失敗した PATCH は成功済みにせず、安全に再試行できる。
- Actio 側が失敗したとき、返信者に失敗が分かる (成功したように見せない)。
- 対応表による番号解決 / 範囲外 / 競合 / 冪等 / 認可拒否 / 失敗後再試行の単体テストが green。

## 依存

`2026-09-04-team-card-kinds-review-delay-adjust` (`review` kind の追加) が先。
