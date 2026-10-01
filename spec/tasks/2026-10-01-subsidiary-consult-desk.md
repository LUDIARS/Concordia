---
task: 2026-10-01-subsidiary-consult-desk
project: Concordia
kind: 実装
created: 2026-10-01
memory_links: []
---
# 子会社の相談窓口 (プロジェクトを持たない相談・子会社の /consult)

設計正本: `spec/feature/tech-consultation.md` §6 (`SPEC-CONSULT-PROJECTLESS`)。
2026-10-01 neco 指示「GLab 子会社に相談窓口用意」「元々相談課はプロジェクト外のものを受け付ける課。
private チャンネルを作れるようにして、管理者と本人のみ一旦見れる状態にする」。範囲「プロジェクト不要」、
閉じ込め「この設計で着手」(同日回答)。

## 目的

子会社 (GLab) のメンバーが、プロジェクトに縛られない技術の質問を、部署フォーラムまたは本人と管理者だけが
見られる閉じたチャンネルで相談できるようにする。本社の作業領域は子会社の相談から読ませない。

## 完了条件

- [x] 担当プロジェクトを持たない読み取り専用ユースケースの部署を判定する純関数を consultation に置く (CC-CONSULT-INV-06)。
- [x] 子会社の部署フォーラムで、その部署はプロジェクトを拾わず関係プロジェクトの照合もせずに起動する。
- [x] admin spawn がその起動を子会社ごとの空の相談用ディレクトリに固定し、claude の `--tools=WebSearch,TodoWrite --strict-mcp-config --disable-slash-commands` を付ける。作業領域・引数・provider の指定は拒否する (CC-CONSULT-INV-07)。
- [x] `/consult` を子会社 guild に登録し、その子会社の相談部署だけを受ける。閲覧者は名簿の権限者のうちその guild に在籍する人と本人。
- [x] 子会社では公開候補 (`/consult wrap`・判断カード) を出さない。
- [x] 単体・結合テストを同じ変更で書き、`cc.acceptance.json` に対応付ける。
- [ ] 反映後、GLab に技術相談課 (技術相談ユースケース・プライベート相談 有効・権限者 管理職以上) を作る。

## スコープ (編集可ディレクトリ)

- `src/consultation/`、`src/discord/` (consult-*・forum-spawn・subsidiary-scope・bot の配線)、`src/api/register-core.ts`、`src/bootstrap/core.ts`
- `tests/`、`spec/feature/tech-consultation.md`、`spec/feature/departments.md`、`spec/feature/subsidiary-delegation.md`
