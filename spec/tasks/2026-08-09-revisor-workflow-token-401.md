---
task: revisor-workflow-token-401
project: Concordia
kind: 雑用
status: pending
created: 2026-08-09
source_session: lictor-2486e1de-37fa-454c-b2ce-e69443befb1f
memoria_task_id: null
actio_task_id: null
memory_links:
  - spec/feature/revisor-local-pr-submission.md
---

# Revisor 書き込みトークンが 401 で local PR を提出できない

## 目的

`POST /v1/prs/local` が Revisor の書き込み API で 401 になり、セッションの作業ブランチを
local PR として提出できない状態を解消する。レビュー発火経路が実質止まっているため、
「提出したつもりで誰もレビューしていない」を作らない。

## 事象 (2026-08-09 観測)

- `POST http://127.0.0.1:11111/v1/prs/local {"session_id": ...}`
  → `{"submitted":false,"reason":"error","detail":"Revisor /v1/local-prs failed (401): unauthorized"}`
- 一方 `GET /v1/prs/revisor` は成功し `base_url: http://127.0.0.1:4240` と open PR 一覧を返す。
  → Revisor 自体は稼働中で、**読み取りは通り書き込みだけが 401** = トークン未配布 / 失効。
- 書き込みトークンは `revisor_config` (secret-box) が正本で env `CONCORDIA_REVISOR_WORKFLOW_TOKEN`
  がフォールバック (`src/pr/revisor-config.ts` / `revisor-token.ts`)。解決は都度行うので、
  設定を入れれば Concordia の再起動は不要のはず。
- 参考: `lictor cli` も同マシンで `node-pty` 未ビルドにより起動しない (別件だが CLI 経由の
  提出も使えない)。

## 完了条件

- [ ] Revisor 側の現行トークンを確認し、Concordia の `revisor_config` (WebUI) か env に設定する。
- [ ] `POST /v1/prs/local` が `submitted: true` を返すことを実セッションで確認する。
- [ ] 401 のまま放置されないよう、提出失敗が可視化されているか (ログ / 通知) を確認する。
      無ければ「レビュー発火が黙って死ぬ」再発防止として通知を足すか、別タスクに切り出す。

## スコープ (編集可ディレクトリ)

- 設定投入のみ (WebUI の Revisor 設定 / env)。コード変更が要るのは可視化を足す場合だけで、
  その場合も `src/pr/` に閉じる。

## 保留中の影響

- ブランチ `feat/rwf-pr-merge-ui` (コミット `4cf8549e`) が未提出のまま。トークン復旧後に提出する。
