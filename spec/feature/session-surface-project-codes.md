---
type: feature
title: "セッション投稿タイトルのプロジェクトコード — 触っている全リポを載せる"
description: "forum スレッド名の [..] 接頭辞を、repo_path 1 本の leaf 推測から『Lictor が追跡している active repo 群を正準リポ root に解決し、その全プロジェクトコードを並べる』方式へ変える。worktree ディレクトリ名やワークスペース root (Ar) がそのまま出るのを止める。"
service: concordia
domain: interface
tags:
  - discord
  - forum
  - lictor
  - project-codes
status: planned
related:
  - feature/discord-forum-migration.md
  - feature/discord-lictor-relay.md
  - feature/inquiry.md
updated: 2026-08-02
---

# セッション投稿タイトルのプロジェクトコード

> 2026-08-02 neco 指示 (項目 1)。 「Lictor に作業リポジトリを登録した後の挙動が不安定。
> 投稿のタイトルにアクセスしているプロジェクトコードを設定する。 wt 名や Ar のままは NG。
> 全部載せる。」

## 1. 現状と不具合

- Cc は `projectResolver.codeForRepo(state.repoPath)` (`src/discord/forum-project-code.ts`)
  で **repo_path 1 本だけ**からコードを引いている。
- `codeForRepo` は **ディレクトリ leaf の名前推測**で解決する:
  1. leaf が PROJECT-CODES のプロジェクト名と完全一致 → そのコード
  2. leaf が `<Project>-<何か>` で始まる → そのプロジェクトのコード
  3. どちらでもない → **leaf 文字列をそのまま返す**
- このため次が壊れる:
  - `.wt-Cc-inquiry` / `.worktrees/cc-drop-os-monitor` のような worktree は 1 にも 2 にも
    当たらず、 **ディレクトリ名がそのままタイトルに出る**。
  - ワークスペース root (`E:/Document/Ars`) で wrap したセッションは leaf が `Ars` なので
    **`Ar` に解決されてしまう**。 実際に触っているのは Cc や Li でも `[Ar]` と出る。
  - 多リポ横断セッションでも 1 本しか出ない。
- 一方 **Lictor は既に active repo 群を持っている** (`src/active-repos.ts` +
  `wrap.ts` の active-repo relay)。 ただし Cc に渡しているのは
  `patchSession({ repo_path: activeCwd })` の 1 本と、
  `lictor.active_repo.changed` イベント payload の `repos` だけで、
  **イベントは `activeChanged` のときしか送っていない** (リストだけ増えた場合は届かない)。

## 2. 方針

### 2.1 Lictor 側 — 正準リポ root に解決してから送る

- active repo の各エントリについて `git rev-parse --git-common-dir` を引き、
  **worktree ではなく本体リポの root** を求める。 これで `.wt-Cc-*` /
  `.worktrees/*` / `<Project>-<branch>` の全パターンが名前推測なしで解決する。
- 解決結果を `patchSession` に **`active_repos: string[]`** として送る (新フィールド)。
  `repo_path` は従来どおり「直近に触れたリポ」を入れる (既存の衝突判定・
  spawn 判定がこれに依存しているため変えない)。
- 送信条件を `activeChanged || listChanged` にする (現行は `activeChanged` のみ)。

### 2.2 Cc 側 — 全コードを並べる

- `sessions.active_repos` (TEXT / JSON 配列) を新設し、 lifecycle で保存する。
- Cc DB の `project_codes` registry を正本とし、`ForumProjectResolver` に
  `codesForRepos(repoPaths: string[]): string[]` を追加:
  1. 各パスを registry の repo_path / worktree leaf と突き合わせて解決する
  2. **registry に載っていないパスはコードを持たないので、そもそも出てこない**
     — worktree 名や一時ディレクトリがタイトルに出ることを構造的に防ぐ
     (`codeForRepo` の leaf フォールバックは単独解決専用で、ここでは使わない)
  3. **ワークスペース root (`Ar` / Ars) は、 他に 1 つでもコードがあれば捨てる**
     — root は「wrap した場所」であって作業対象ではない
  4. 重複除去し、 `active_repos` の出現順 (= 触った順) を保つ
- タイトル接頭辞は `[<code1>+<code2>+…]`。 例: `[Cc+Li] お伺いプロトコル実装`。
- コードが 1 つも残らなかった場合のみ、 従来の `codeForRepo(repo_path)` 結果を
  フォールバックとして使う (完全に空のタイトルにはしない)。
- 上限は 4 コードまで。 超えたら先頭 4 つ + `+n`。

### 2.3 更新契機

タイトルは以下で貼り直す:

- セッション登録時 (`onSessionRegistered`)
- `lictor.active_repo.changed` 受信時 (新規: 現状はタイトルを更新していない)
- 既存の title_renamed / branch_changed 経路

`onSessionTitleChanged` にも `projectCode` ではなく **`projectCodes: string[]`** を渡す。

## 3. 受け入れ条件

1. `.wt-Cc-inquiry` で作業しているセッションのタイトルが `[Cc]` になる
   (`.wt-Cc-inquiry` という文字列がタイトルに現れない)。
2. ワークスペース root で wrap し Concordia と Lictor を触ったセッションの
   タイトルが `[Cc+Li]` になる (`[Ar]` にならない)。
3. どのリポも触っていない起動直後のセッションは、 root しか無いので `[Ar]` のまま
   (フォールバック) で、 空タイトルにならない。
4. 作業中に触るリポが増えたら、 次の relay tick でタイトルにコードが増える。
