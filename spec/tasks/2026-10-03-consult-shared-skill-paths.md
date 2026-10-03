---
task: 2026-10-03-consult-shared-skill-paths
project: Concordia
kind: 実装
created: 2026-10-03
memory_links: []
reference: actio:fc2497b0-e8bd-4832-b0d9-fa7bb98638fc
---
# 相談窓口: 役職フォルダの指示の読み込み先を Codex と Claude Code の共有配置に合わせる

設計正本: `spec/feature/tech-consultation.md` §6 (この task で更新する)。前段: `spec/tasks/2026-10-02-consult-role-guidance-inline.md` (#2303、マージ済み)。
2026-10-03 neco 指示「いまスキルやメモリは共有できるはずなので共有しましょう」「Codex と Claude Code が同じものを読むって話」。

## 目的

相談の作業ディレクトリ (既定 `E:/Document/Consult/<役職>`) の指示ファイルとスキルは、Codex と Claude Code の両方が読める配置に移した
(2026-10-03、Consult 側は反映済み):

- 指示: `<役職>/AGENTS.md` と `<役職>/CLAUDE.md` (同じ内容。Codex は AGENTS.md、Claude Code は CLAUDE.md を読む)
- スキル: `<役職>/.agents/skills/<名前>/SKILL.md` (両方が読む共有配置。旧 `.claude/skills/` は廃止)

#2303 で入れた「指示ファイルを読めない provider への初回指示の載せ込み」は `CLAUDE.md` と `.claude/skills/` だけを読むので、
新しい配置では何も載らない。読み込み先を共有配置に合わせる。失うと困る利用者の状態: Astra で起動するデザイナー・サウンドの相談で、
役職の手順が初回指示に載らない。

- 価値: UX-CC-W6 / シナリオ UX-CC-S7
- ドメイン: consultation

## 設計

1. `src/consultation/role-guidance-files.ts` (`readRoleGuidanceFiles`)
   - 指示ファイル: `AGENTS.md` を読む。無ければ `CLAUDE.md` を読む。両方あるときは `AGENTS.md` だけ (同じ内容の二重載せを避ける)。
   - スキル: `.agents/skills/*/SKILL.md` を読む。フォルダが無ければ `.claude/skills/*/SKILL.md` を読む。両方あるときは `.agents/skills` だけ。
   - 読む場所の一覧は定数にして、テストと spec で同じ順序を参照できるようにする。
   - 読めない (ENOENT 以外) の扱い、本文をログに出さない方針は変えない。
2. `src/consultation/projectless-consult.ts`
   - `PROJECTLESS_CONSULT_CLAUDE_ARGS` のコメント「スキルは役職フォルダのものを使う」の説明を共有配置に合わせる (引数自体は変えない)。
   - `consultWorkspaceClaudeSettings` の `claudeMdExcludes` は上位フォルダと相談者のデータフォルダの `AGENTS.md` も既に外している。変更不要なことを確認する。
3. spec
   - `tech-consultation.md` §6 の「スキルは役職フォルダ (`<役職>/.claude/skills`) のものだけを使う」「役職フォルダ自身の CLAUDE.md とスキル (`.claude/`)」の記述を、
     `AGENTS.md` / `CLAUDE.md` と `.agents/skills` に書き換える。読み込み先の優先順 (共有配置 → 旧配置) を 1 行で書く。
   - `CC-CONSULT-INV-11` の強制箇所に読み込み先の定数名を書く。
   - `cc.acceptance.json` の対応付けを確認し、変更したファイルが対応していることを確かめる。

## やらないこと

- `E:/Document/Consult` 配下は変更しない (反映済み)。
- codex の閉じ込め引数 (`project_doc_max_bytes=0` など) は変えない。Astra が AGENTS.md やスキルを自分で読めるようにするのは別件。
- ブロックの見出し・文面・上限・省き方 (`role-guidance.ts`) は変えない。

## 受け入れ条件

- [x] 役職フォルダに `AGENTS.md` と `.agents/skills/` だけがあるとき、その内容が初回指示のブロックに載る。
- [x] 旧配置 (`CLAUDE.md` と `.claude/skills/`) だけのときも、従来どおり載る。
- [x] 両方あるときは共有配置だけを読み、同じスキルが二重に載らない。
- [x] `role-guidance-files.test.ts` に上の 3 つのケースがある。
- [x] spec §6 の記述が実際の配置と一致する。

## 復旧

読み込み先の順序だけの変更で状態を持たない。問題が出たら定数の順序を戻す。

## 実施結果

### 再利用探索

- 読み込みは既存の `readRoleGuidanceFiles` を拡張した (新しい読み込み関数は作らない)。ブロック組み立て (`role-guidance.ts`) はそのまま再利用。
- 契約の observe ランタイムは既存の `src/consultation/ontime-runtime.ts` を使う。`readRoleGuidanceFiles` は既存関数のため `augur inject` の自動注入対象外 (applied=0) で、`role-guidance.ts` と同じ形で手動配線した。
- `consultWorkspaceClaudeSettings` の `claudeMdExcludes` は上位フォルダと相談者データフォルダの `AGENTS.md` を既に外しており変更不要 (役職フォルダ直下の AGENTS.md は対象外のまま)。

### 検証

- 実施: `tsc --noEmit` (エラー 0)。
- 未実施: vitest (委託指示によりテストは実行しない)。`role-guidance-files.test.ts` に共有配置のみ / 旧配置のみ / 両方 / 読み込み順の定数 の 4 ケースを追加済み。
