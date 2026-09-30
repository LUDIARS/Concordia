---
task: 2026-09-30-consult-private
project: Concordia
kind: 実装
created: 2026-09-30
memory_links: []
---
# プライベート相談 (閉じたチャンネル・権限者の自動追加・招待)

設計正本: `spec/feature/tech-consultation.md` §4 (`SPEC-CONSULT-PRIVATE` / `SPEC-CONSULT-MEMBERS` /
`SPEC-CONSULT-VISIBILITY` / `SPEC-CONSULT-CLOSE`)。director case `dir_687ecaf4` plan v1 承認済み。
事前ヒアリング (`2026-09-30-consult-intake`) の後に着手する。

## 目的

人に見せたくない技術相談を、本人・権限者・招待した人だけが見られる閉じたチャンネルで受ける。

## 完了条件

- [ ] 部署設定に `private` (許可、権限者の最低役職 = 既定 管理職) を足し、部署管理画面で編集できる。
- [ ] `/consult` がモーダルで事前ヒアリングを取り、「プライベート相談」カテゴリに閉じたテキストチャンネルを作ってセッションを起動する。作成要求に閉じた overwrites を含める (CC-CONSULT-INV-01)。
- [ ] 本人・権限者 (社員名簿の判定をチームの「管理」チャンネルと共有)・Bot だけが見られる。`/consult invite` / `remove` は本人と権限者だけが使え、本人と Bot は除外できない (CC-CONSULT-INV-02)。
- [ ] 思考・カード・コスト報告はそのチャンネルにだけ出し、activity / monitor / pr-queue / 連合に本文・題名を出さない (CC-CONSULT-INV-03)。
- [ ] セッション終了でチャンネルを書き込み不可にして残す。
- [ ] 起動できないときはコマンド応答で理由を本人にだけ返す。
- [ ] `private_consultations` / `private_consultation_members` の migration、repo、domain policy、API、Discord 面のテストを同じ変更で書き、`cc.acceptance.json` に対応付ける。

## スコープ (編集可ディレクトリ)

- `src/consultation/`、`src/db/` (private-consultations の repo と schema / migration)、`src/api/consultations.ts`
- `src/discord/` (consult-* とコマンド、出力の配送判定)、`src/departments/` (部署設定)、`web/src/pages/departments/`
- `tests/`、`spec/feature/tech-consultation.md`
