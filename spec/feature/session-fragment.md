---
type: feature
title: "フラグメントとストラクチャード — plan / vibes モードの撤廃後の運用"
description: "セッション契約の plan / vibes モードと、それに付随するゲート (plan-unapproved の編集封鎖、vibes の testing claim 自動取得・時間上限・編集ファイル上限・昇格/降格カード・[OK] 完了レーン) を撤廃する。セッションで指示される作業は設計の大小によらず fragment とし、大きめの設計を Director のプラン工程で整理する流れを structured として残す。作業場所 (repo-root / worktree) はモードと連動させず、repo-root で見たい内容かどうかで初回タスク指示とタスク切り替え時に判定する。"
service: concordia
domain: governance
tags:
  - session-contract
  - fragment
  - structured
  - harness
status: implemented
related:
  - feature/session-contract.md
  - feature/plan-gate.md
  - feature/vibes-mode.md
  - feature/director.md
updated: 2026-10-06
---

# フラグメントとストラクチャード

> 2026-10-06 neco 指示。「Cc の plan と vibes の仕様は邪魔なので撤廃する。大きめの『設計』で
> プランモード的な整理を起動するのは残す」「撤廃後はフラグメントとストラクチャードとして運用する」
> 「設計の大小はあれどセッションで指示されるのはフラグメントとする。vibes かどうかと repo-root で
> 作業するかどうかは実は連動しない。repo-root で見たい内容かどうかで切り分ける。初回のタスク指示
> またはタスク切り替え時に判断する」。

## 1. 区分 {#CC-FRAGMENT-01}

| 区分 | 対象 | 扱い |
|---|---|---|
| fragment | セッションで指示される作業すべて (設計の大小を問わない) | モード固有のゲートを持たない。通常の作業規則 (worktree / Revisor local PR / テスト隔離) に従う |
| structured | 大きめの設計を Director の case + プラン工程で整理して進める作業 | Director のプラン工程 (設問 → 設計 → 承認 → task md 確定 → 委託) を残す。セッションの編集封鎖はしない |

- セッション契約の `mode` は `fragment | structured`。セッション開始・タスク切り替え時の seed は
  `fragment`。Director case に紐づくセッション (`metadata.director_case_id`) だけ `structured` とする。
- 旧契約の `plan` / `vibes` は読み込み時に `fragment` (Director case に紐づくなら `structured`) と
  読み替える。保存済みの値を書き換える移行処理は持たない (次の契約保存で新しい値になる)。

## 2. 撤廃したもの {#CC-FRAGMENT-02}

- **vibes**: 契約確定時の testing claim 自動取得、claim 時間上限 (`CONCORDIA_VIBES_CLAIM_SEC`) と
  延長質問・応答なしでの session `blocked` 化、編集ファイル上限 (`CONCORDIA_VIBES_MAX_FILES`) と
  昇格質問カード、vibes スコープ述語 (`vibes-scope`)、[OK] 発言・ボタンによる完了レーン
  (`vibes.ok` → local PR → 終了)、チーム設定 `vibes_defaults`。
- **plan のセッションゲート**: `plan-unapproved` 述語 (プラン未承認のコード編集 deny)、
  plan ↔ vibes 切替 (`POST /v1/sessions/:id/contract/mode-switch`、`/co-mode`、
  `PATCH .../contract` の `mode_switch_required`)。
- 撤廃の直接の理由の一つ: vibes の claim 時間上限は、5 分の無応答でセッションを `blocked` に落とし、
  後から延長を答えても戻らなかった。`blocked` の間は出力が Discord へ転送されず、人間から見て
  返事が途絶えていた (2026-10-04〜06 に 3 セッションで発生)。

## 3. 作業場所の判定 {#CC-FRAGMENT-03}

- `work_location` は `mode` と連動させない。**repo-root で見たい内容か**で決める。
- 判定時機は契約の seed と同じ: 初回のタスク指示 (spawn) とタスク切り替え (task-change)。
- 決定論 seed: 画面・表示・見た目・UI・レイアウト・スタイル・目視・プレビュー・動作確認・Unity 等、
  本体フォルダで動かして見たい語を含むタスクは `repo-root`、それ以外は `worktree`。
  チーム設定 `worktree: repo-root-only` は従来どおり `repo-root` に固定する。
- seed の後段 (LLM tier / human tier) が上書きできる点、human tier の決定を task-change の再 seed で
  保持する点は session-contract のまま。

## 4. 大きめの設計の整理 {#CC-FRAGMENT-04}

- Director のプラン工程 (plan-gate §1〜§3: 受け入れ条件必須のプラン、設問・設計カード、承認で
  task md 確定 → 委託) は structured として残す。
- 承認の結果は従来どおり session metadata (`plan_approved` / `director_case_id` / `plan_version` /
  `plan_md_ref`) に残すが、編集ゲートには使わない。

## 5. 受け入れ基準

- [ ] 新規契約の `mode` は `fragment` (Director case 紐付きなら `structured`) で、旧 `plan` / `vibes` を
      含む契約も読み込める。
- [ ] testing claim の自動取得・時間上限・延長質問・`blocked` 化が起きない。
- [ ] `plan-unapproved` / `vibes-scope` / `vibes-file-limit` 述語が無い。
- [ ] `work_location` がタスク文の「repo-root で見たい内容か」で決まり、mode に依存しない。
- [ ] mode-switch API と `/co-mode` が無い。
