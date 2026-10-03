---
task: 2026-10-03-consult-log-end
project: Concordia
kind: 実装
created: 2026-10-03
taskflow_reference: actio:98e2f489-cdf7-4346-a879-1a515a6747ca
memory_links: []
---
# 相談の「終了」と相談ログ

設計正本: `spec/feature/tech-consultation.md` §6.1 / §6.2 (`SPEC-CONSULT-LOG`)、`spec/feature/session-end-request.md`。
2026-10-03 neco 指示「『終了』でセッション終了します (相談窓口で終了と言われたら終了する)」「相談内容は Consult フォルダに
すべてログとして保存する」「時刻は JST」。

## 目的

相談者が相談窓口で「終了」と言えば相談が終わり、相談の中身 (事前ヒアリング・相談者の発言・最終回答) が相談者の
データフォルダに Markdown で残る。

## 完了条件

- [x] 相談の部署のセッションだけ、一言の「終了」等を終了の指示として扱う。相談以外では拾わない。打ち消しは対象外。
- [x] 相談では起動した相談者本人も自分の相談を終えられる (権限者以外の相談者が「終了」を使えるように)。
- [x] 相談ログを `<役職>/<Discord ID か _unknown>/logs/<YYYY-MM-DD>_<session id>.md` に発言ごとに追記する (JST)。
- [x] 指令・途中の発言・ツール出力は書かない。書き込みの失敗は warn だけで相談を止めない。
- [x] 仕様 (tech-consultation.md §6.1 / §6.2、session-end-request.md) を更新する。
- [x] 単体テストを同じ変更で書き、`cc.acceptance.json` と Augur の台帳・契約に対応付ける。

## スコープ (編集可ディレクトリ)

- `src/consultation/` (consult-end-word / consult-log-markdown / consult-log-writer)
- `src/discord/ingress.ts`、`src/discord/bot.ts` (相談セッションの判定の配線)
- `src/bootstrap/core.ts` (相談ログの購読の配線)
- `spec/feature/`、`spec/tasks/`、`cc.acceptance.json`、`augur.contracts.json`、`.augur/tests.jsonl`
