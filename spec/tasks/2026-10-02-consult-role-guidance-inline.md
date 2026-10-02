---
task: 2026-10-02-consult-role-guidance-inline
project: Concordia
kind: 実装
created: 2026-10-02
memory_links: []
---
# 相談窓口: 指示ファイルを読めない provider へ役職の指示を初回指示に載せる

設計正本: `spec/feature/tech-consultation.md` §6 (この task で追記する)。
2026-10-02 neco 指示「役職は spawn 前に決定するので読み分けで良い」。

## 目的

相談の作業ディレクトリ (既定 `E:/Document/Consult/<役職>`) には、役職ごとの `CLAUDE.md` と `.claude/skills/*/SKILL.md` を人が置く
(2026-10-02 に共通 5 本 + 役職別 1 本を配置済み)。claude で起動する相談 (エンジニア・企画・不明) はこれを自分で読む。
Astra (codex) で起動する相談 (デザイナー・サウンド) は、閉じ込めの引数 (`--disable shell_tool` / `-c project_doc_max_bytes=0` /
`--disable plugins`) のために `CLAUDE.md` もスキルも読めず、役職ごとの回答の作り方が効かない。

役職は起動前に決まっている (`consultRoleFolder`) ので、指示ファイルを自分で読めない provider で起動するときは、
Cc が役職フォルダの `CLAUDE.md` とスキルを読んで初回指示に載せる。失うと困る利用者の状態: デザイナー・サウンドの相談者だけ、
技術レベルに合わせた回答・非公開の内容を検索語に入れない・できない依頼の断り方などの手順が適用されない回答を受け取る。

- 価値: UX-CC-W6 / シナリオ UX-CC-S7
- ドメイン: consultation (`spec/domains/consultation.domain.json`)

## 設計

1. 業務判断 (純関数) `src/consultation/role-guidance.ts`
   - `needsInlineRoleGuidance(provider)`: claude は自分で読むので false。それ以外は true。
   - `stripSkillFrontmatter(text)`: SKILL.md 先頭の YAML frontmatter (`---` 〜 `---`) を外した本文を返す。frontmatter が無ければそのまま。
   - `buildRoleGuidanceBlock({ claudeMd, skills, maxChars })`: 初回指示に載せるブロックを返す。載せるものが無ければ null。
     - 見出しは `## 相談窓口の前提と手順`。続けて「このセッションではスキルを呼び出せません。『〜を読んでください』とある手順は、
       下に全文を載せています」の 1 行を置く (`CLAUDE.md` の文面はスキルを呼び出す前提で書かれているため)。
     - `CLAUDE.md` の本文、続けてスキルごとに `### 手順: <スキル名>` と本文 (frontmatter を外したもの)。スキルは名前順。
     - 全体が `maxChars` (既定 40,000 文字) を超えるときは、スキル単位で後ろから載せるのをやめる。途中で切った本文は載せない。
       載せなかったスキル名を返り値に含め、呼び出し側が warn ログに出す (本文はログに出さない)。
2. 読み込み (adapter)
   - 役職フォルダ直下の `CLAUDE.md` と `.claude/skills/<名前>/SKILL.md` だけを読む。相談者のデータフォルダ (`<役職>/<Discord ID>/`) や
     上位のフォルダは読まない (CC-CONSULT-INV-08 と同じ範囲)。
   - ファイルが無い・読めないときは、その分を載せずに起動を続ける (起動できないほうが困る)。warn ログを 1 行出す。
   - `resolveProjectlessConsultLaunch` の ports に足すか、admin spawn 側の小さな関数にするかは既存の責務分担に合わせる。
     純関数から fs を直接呼ばない。
3. 配線 (admin spawn、`src/api/register-core.ts`)
   - 相談の作業ディレクトリで起動し (`consultConfinement !== null`)、解決後の provider が `needsInlineRoleGuidance` のときだけ載せる。
   - 置き場所は「作業範囲の制限」の直後、対話の前提データ (`dialogueBlock`) の前。
   - claude で起動するときは載せない (自分で読むので二重になる)。
   - テンプレート経路・素の経路のどちらで初回指示が組まれても載ること (provider はテンプレート解決後に決まる点に注意)。
4. spec
   - `spec/feature/tech-consultation.md` §6 に「指示ファイルを読めない provider では、役職フォルダの CLAUDE.md とスキルを Cc が初回指示に載せる」を追記。
     §2 の不変条件に `CC-CONSULT-INV-11`「相談セッションは provider に関わらず、役職フォルダの指示 (CLAUDE.md とスキル) を受け取る。
     載せるのは役職フォルダ自身のものだけ」を足し、強制箇所を書く。§6 の「残る露出」「view_image」の記述は変えない。
   - `spec/domains/consultation.domain.json` と `cc.acceptance.json` に source / tests を対応付ける。

## やらないこと

- `E:/Document/Consult` 配下のファイル (CLAUDE.md・スキル・sync.mjs) は変更しない。
- codex の閉じ込め引数は変えない (シェルや AGENTS.md の読み込みを戻さない)。
- claude の起動経路の挙動は変えない。
- `/consult wrap` の公開候補の登録経路 (セッションに送信手段が無い件) は別件。この task では触らない。

## 受け入れ条件

- [ ] provider が codex の相談起動で、初回指示に `## 相談窓口の前提と手順` と、役職フォルダの CLAUDE.md・各スキルの本文 (frontmatter なし) が入る。
- [ ] provider が claude の相談起動では、このブロックが入らない。
- [ ] 相談以外の起動 (プロジェクトを持つ部署・部署なし) では入らない。
- [ ] 役職フォルダに CLAUDE.md もスキルも無いときはブロックを作らず、起動は成功する。
- [ ] 上限を超えるときはスキル単位で省き、途中で切れた本文が載らない。
- [ ] 相談者のデータフォルダの中のファイルは読まれない。
- [ ] 純関数のテストと、admin spawn の配線のテスト (`tests/projectless-consult-spawn.test.ts` か同等) を同じ変更に含める。
- [ ] `cc.acceptance.json` と `spec/domains/consultation.domain.json` に対応付けがある。

## 復旧

ブロックの追加だけで状態を持たない。問題が出たら配線の呼び出しを外せば従来の初回指示に戻る。
