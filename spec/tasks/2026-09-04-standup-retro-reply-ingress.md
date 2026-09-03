---
task: standup-retro-reply-ingress
project: Concordia
kind: 実装
created: 2026-09-04
memory_links:
  - spec/tasks/2026-09-04-review-card-reply-ingress.md
  - spec/feature/teams.md
  - spec/feature/team-standup-and-review.md
---
# 定例・朝礼カードの返信を Actio の 3 テーブルへ取り込む

## 目的

Actio `spec/feature/team-task/spec.md` §15.5 / §10「Cc 側変更 5」。
Actio 側の設計では定例 (`team-review-regular`, 火金 13:00) を **Cc に残す**判断 (§10) だが、
現在の Cc では `teams.md` §0.5 と `team-standup-and-review.md` により朝礼・定例 cron とも
休止中である。再開または別のカード生成元を定めない限り、返信 ingress だけを実装しても
入力が発生しない。そのうえ、そこで出た内容が Actio に入らないままだと、
次スプリント案を作る材料 (前スプリントの `sprint_metrics` と
`problem`) が揃わない。朝礼の稼働申告・実績も同様。

3 系統の返信 ingress を Cc 側に足す:

| 返信元 | 変換先 | 備考 |
|---|---|---|
| 定例カードの返信 | `sprint_retros` の `keep` / `problem` / `try` | `source='cc-regular'` |
| 朝礼返信 `⏱ 6h` | `member_availability` | 稼働申告 |
| 朝礼返信 `✅ 90m` | `work_logs` | 実績 |

対象にできる Discord message をカード投稿時に永続化し、message ID から
team / sprint / date / reply kind を一意に解決する。本文や投稿時刻から対象を推測しない。

## 完了条件

- 定例カードの返信が `keep` / `problem` / `try` に振り分けられ、`source='cc-regular'` で保存される。
- 朝礼返信の `⏱ <時間>` が `member_availability`、`✅ <時間>` が `work_logs` へ入る。
- Discord 返信者を Actio の member に一意に対応付けられない場合、または work log の
  対象タスクを一意に解決できない場合は取り込まず理由を返す。
- 時間表記の解釈に失敗した返信は、勝手に既定値を入れず取り込まない (誤った実績を作らない)。
- Discord message ID を冪等キーとして永続化し、同一返信の再配信・bot 再起動で
  二重登録しない。Actio への書き込み失敗を成功済みにせず、安全に再試行できる。
- 対象スプリント / 対象日が特定できない返信は取り込まず理由を返す。
- 3 系統それぞれの対象解決・解釈・冪等・失敗後再試行の単体テストが green。

## 依存

- `2026-09-04-team-card-kinds-review-delay-adjust` (対象カード種別の追加) が先。
- `teams.md` §0.5 の休止方針との優先関係を決め、朝礼・定例を再開するなら
  `teams.md` / `team-standup-and-review.md` の status・cron 契約も同じ変更で更新する。
  再開しないなら、同じ永続対応表を作れる代替のカード生成元を先に定義する。
