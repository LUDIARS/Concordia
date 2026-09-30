---
task: 2026-09-30-consult-publish-tabula
project: Concordia
kind: 実装
created: 2026-09-30
memory_links: []
---
# プライベート相談からの公開候補と Tabula への投稿

設計正本: `spec/feature/tech-consultation.md` §5 (`SPEC-CONSULT-PUBLISH` / `SPEC-CONSULT-TABULA`)。
director case `dir_687ecaf4` plan v1 承認済み。プライベート相談 (`2026-09-30-consult-private`) と、
Tabula の取り込み API の共有範囲指定 (Tabula `spec/tasks/2026-09-30-import-member-sharing.md`) の後に着手する。

## 目的

プライベート相談から出た汎用的な知見だけを、相談者本人の承認つきで全体の資産 (Tabula) にする。

## 完了条件

- [ ] 相談の区切り (終了時・`/consult wrap`) にセッションへ公開候補づくりを依頼し、書き直した要約を API で受け取る。会話の転載・個人・社内固有・秘密・人の評価を含めない。
- [ ] 候補をチャンネルにボタン付きで出す (公開する / 直して公開 / 公開しない)。公開を決められるのは本人だけ、権限者は取り下げのみ (CC-CONSULT-INV-04)。
- [ ] 承認された要約を Tabula にメンバー共有ページとして投稿し、URL をチャンネルへ返す。タグは「技術相談」と部署名。
- [ ] Tabula の接続先と取り込みトークンを設定 UI (DB) で持つ。未設定なら公開ボタンを出さず理由を示す。投稿失敗は候補を残して理由を返す。
- [ ] `consultation_publications` の migration、repo、domain policy、API、Discord 面、Tabula クライアントのテストを同じ変更で書き、`cc.acceptance.json` に対応付ける。

## スコープ (編集可ディレクトリ)

- `src/consultation/`、`src/db/` (consultation-publications の repo と schema / migration)、`src/api/consultations.ts`
- `src/discord/` (consult-*)、`src/config/settings/` (Tabula 接続設定)、`web/src/pages/` (設定画面)
- `tests/`、`spec/feature/tech-consultation.md`
