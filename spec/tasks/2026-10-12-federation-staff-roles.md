---
task: federation-staff-roles
project: Concordia
kind: 実装
created: 2026-10-12T00:00:00.000Z
memory_links: []
---
# 本社の社員名簿の役職を拠点へ配る

neco 指示 (2026-10-12): 「MELPOTのDiscordで権限が無いといわれるが権限はあるはずなので調査」→ 直し方は「本社の名簿を配る」。
MELPOT の名簿では neco が staff (ヒラ社員) のため `/end-session` が session_end 不足で拒否されていた。

仕様: spec/feature/federation-link.md §SPEC-FED-STAFF-ROLES

## 受入条件

- 本社で管理職以上の人は、拠点でも同じ役職の権限 (例: end-session) を持つ。
- 拠点の名簿で上げた役職は下がらない。名前・メモは拠点へ渡さない。
- 本社で役職を変えると、つながっている拠点へ配り直される。
- 古い本社 / 拠点と組み合わせても連合リンクは止まらない。
