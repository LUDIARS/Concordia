# 実装委託が初回ターンで「承認待ち」の質問を返して停止する

- Date: 2026-08-09
- Status: fixed — 段階注入 (spec/feature/delegation-staged-injection.md) を実装
- Area: Concordia Delegation / 初期 inject の責務境界
- Severity: high — 委託した実装セッションが 1 ターン目で止まり、委託元は答えようのない質問を受け取る

## Summary

Claude / Opus の実装委託セッションが、auto permission mode であっても**初回ターンで
質問を返して停止**する事例が続いた。停止の中身は「どのファイルを直しますか」「この方針で
よいですか」といった、委託元がまだ答えを持っていない問いだった。

これは 2026-08-08 の
[Claude Delegation Sessions Stall in Invisible Permission Waits](2026-08-08-claude-delegation-session-stall.md)
とは**別の原因**である。あちらは Lictor の permission classifier が `auto` を人間確認へ
分類していた問題 (Lictor #332 の責務)。こちらは Concordia が渡す**固定初期 inject の
中身**が原因で、permission が正しく auto でも同じ停止が起きる。

## 一次証拠

`src/delegation/persona-context.ts` (修正前) は、実装委託の初回プロンプトで
タスク本文の丸投げと次の指示を同時に渡していた。

```
### 勝手に作業しない (重要)
- 方針が複数あり得る / スコープが曖昧 / 影響が大きい場合は、 着手前に方針を 1〜3 行で示して
  ユーザの承認を待ちます。 「やっておきました」 ではなく 「こう進めてよいですか」 が既定。
- 調査・読み取りは進めてよいですが、 変更を伴う一歩はユーザの GO を確認してから踏み出します。
```

一方でタスク本文 (`rendered_prompt`) は「〜を設計・実装せよ」という粒度で渡っていた。

## 根本原因

初回 inject が 2 つの責務を同時に負っていたこと。

1. **何をするか** (タスク本文の丸投げ)
2. **どう振る舞うか** (方針が割れるならユーザ承認を待つ)

意味のある実装タスクはほぼ必ず「方針が複数あり得る / 影響が大きい」に該当するため、
指示に忠実なモデルほど 1 ターン目で承認待ちに入る。これは permission の設定ではなく
**プロンプトの契約**が要求している停止なので、permission を auto にしても消えない。

さらに委託元 (親セッション / ユーザ) は、委託先がまだ調査していない時点の質問に答えられない。
「答えられない問いを投げさせる」構造そのものが欠陥だった。

## 修正

初回 inject の責務を**調査**に限定し、実装タスクを後追いに分けた
(spec/feature/delegation-staged-injection.md)。

- 第 1 段階 (spawn 時): 対象リポジトリ・安全境界・調査姿勢・調査テーマ 1 行だけを渡す。
  姿勢は `investigation` に切り替え、`approval` の承認待ち文言とは**排他**にする
  (併存させると矛盾を安全側に解釈して結局止まる)。
  停止して質問してよいのは (a) 外部権限が必要 (b) 本当に不可逆 の 2 条件のみ、根拠付き。
- 第 2 段階 (`POST /v1/delegation/runs/:id/investigated` を受けて): 理由 (why)・実装タスク・
  Memoria タスク id/link・完了条件を 1 通にまとめて inject する。

## この修正が触っていないもの

- **Claude native auto permission の判断** — Lictor #332 の責務。allow/deny を強制しない。
- **delegation run watchdog** — `run-watchdog.ts` は列も挙動も変更しない (再有効化もしない)。
- **Memoria 本体** — 既存の `POST /api/tasks` のみ使用。

## 回帰テスト

- `src/delegation/staged-injection.test.ts` — 適用条件、調査ブリーフに承認待ち文言が
  入らないこと、タスク本文が第1段階へ漏れないこと、follow-up に why/Memoria/完了条件が
  揃うこと、Memoria 未作成が黙って省略されないこと。
- `src/delegation/persona-context.test.ts` — `investigation` 姿勢で承認待ち節が消え、
  `approval` では従来どおり出ること。
- `src/delegation/staged-followup.test.ts` — 2 回目以降の報告で実装タスクを再配信しないこと、
  Memoria 障害でも配信を止めないこと、後から作成できたら id だけ補足すること。
- `src/api/delegation-staged-injection.test.ts` — 実 DB (in-memory) 越しの冪等性と
  `run_not_staged` / 未接続ガード。
