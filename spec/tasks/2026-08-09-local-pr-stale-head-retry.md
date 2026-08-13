---
type: task
title: "running 中の local PR が rebase 後の head を再レビューできない (stale head retry)"
task: local-pr-stale-head-retry
project: Concordia
kind: 実装
status: todo
service: concordia
created: 2026-08-09
updated: 2026-08-13
spec: spec/feature/cc-workflow.md
memory_links: []
---

# running 中の local PR が rebase 後の head を再レビューできない

## 目的

同じブランチに open な local PR がある状態でブランチを rebase / 追加コミットすると、
Revisor に記録された `headSha` が古いまま取り残され、レビュー対象が現在の HEAD と
食い違う。`POST /v1/prs/local/direct` は `already_open` を返して何もせず、Cc の retry 経路も
発火しないため、セッション側からは復旧手段が無い。

実際に踏んだ事例: local PR `LUDIARS/Concordia #350`
(id `ce462c57-6748-40ec-a706-47a5be83b043`) は 2026-08-09 時点で
`checkStatus: running` / `headSha: 27557d94` のまま、rebase 後の source HEAD
`9271f75b` と食い違った。今回の再 rebase でも同じ経路を通るため、PR の head 更新を
手作業の例外にしない修正が別タスクとして必要である。

## 原因

`src/pr/local-pr-submission.ts` の `planLocalPrSubmission` は、同一ブランチの open PR を
重複として検出したあと `duplicate.checkStatus` が `failed` / `action_required` のときだけ
`{ submit: false, retry: true }` を返す。それ以外 (`running` / `test_ok` 等) は
`already_open` で打ち切るため、head がずれていても再レビューを促せない。

Revisor 側の `POST /v1/local-prs/:id/retry` は workflow token を要求する保護エンドポイントで、
セッションから直接叩く運用にはできない (トークンをセッションへ渡さない方針)。

## 完了条件

- [ ] `planLocalPrSubmission` が「重複 PR の `headSha` と提出対象ブランチの現 HEAD が異なる」
      場合に retry を返すこと (checkStatus に依存しない判定を追加する)。
      判定に使う現 HEAD は既存の `listBranchCommits` と同じ git 経路で解決する。
- [ ] `running` 中の PR に対して retry を投げる際の扱いを決める
      (即 retry / 完了待ちのどちらかを明文化し、二重ジョブを作らないこと)。
- [ ] `already_open` を返す場合でも、head が一致しているときだけであることをログと
      レスポンス detail で判別できるようにする (無言のスキップを作らない)。
- [ ] 回帰テストを `src/pr/local-pr-submission.test.ts` に追加
      (head 一致 → `already_open` / head 不一致 → `retry`)。
- [ ] 上記反映後、#350 を現行 HEAD で再レビューさせる。

## スコープ (編集可ディレクトリ)

- `src/pr/`
- 必要なら `src/api/prs.ts` (レスポンス detail の追加のみ)

## 意図的に対象外

- Revisor 側の API 変更 (`/v1/local-prs/:id/retry` の認可緩和を含む)。
- workflow token をセッションへ配布する仕組み。
