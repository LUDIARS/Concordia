---
type: feature
title: "Project code registry — Cc 所有の空初期レジストリ"
service: concordia
domain: project-code-registry
status: implemented
updated: 2026-09-02
---

# Project code registry

Concordia が project code とローカル Git repository の対応を SQLite に保持する。
`LUDIARS/PROJECT-CODES.md` は人間向け略称表として残せるが、Cc の repository binding、
session title、forum routing の正本には使わない。

## 契約

- 新規 DB の registry は空で始まり、既存 Markdown 一覧を seed しない。
- code は大文字小文字を区別する。project、repo path、repo origin は重複登録しない。
- 登録時は configured workspace root 内の Git repository を検査し、canonical root を
  Cc が確定する。project と repo origin は省略時に検査結果から補完し、管理 API/UI から
  明示指定された場合は検証済みの表示名・資格情報を含まない GitHub URL で上書きできる。
- 同じ code と同じ repository の再登録は成功扱いにして、異なる対応への上書きは拒否する。
- API と Discord command から追加でき、追加直後の repository binding に再起動なしで効く。
- 自動削除・自動 import は行わない。

## 操作面

- `GET /v1/project-codes` — 登録一覧。
- `POST /v1/project-codes { code, repo_path, project?, repo_origin?, added_by? }` — 検証済み登録。
- `/project-code add code:<code> repo:<absolute-path>` — 管理職向け Discord command。
- `/project-code list` と `/projects` — 現在の DB 正本を表示。

### 管理 UI

- `GET /v1/project-codes/admin` は loopback 管理面に、監査項目、repo origin、所属チーム、
  所属会社、Revisor workflow を含む一覧を返す。
- 管理 UI の新規登録では project、GitHub URL、Revisor workflow を任意指定できる。
  workflow は registry 登録後に既存の Revisor repository へ設定し、未登録・到達不能なら
  registry 登録を維持したままモード設定の失敗を表示する。
- `PATCH /v1/project-codes/:code` は code / project / repo path / repo origin を部分更新する。
  repo path を変える場合は登録時と同じ workspace・Git repository 検査を必須とする。
- project または repo origin を変更した場合、`subsidiary_projects` / `team_repos` の既存の
  複数割当をすべて新しい識別子へ引き継ぐ。登録を削除した場合は、対応する割当行を残さない。
- `PUT .../team { team_ids }` と `PUT .../subsidiary { subsidiary_ids }` は複数割当を置き換える。
  空配列はそれぞれ無所属・本社のみを表す。既存の多対多契約を単一所属へ縮退させない。
- `PUT .../revisor-workflow` は既存の Revisor repository 登録を round-trip し、登録テストを
  保持したまま workflow だけを変更する。Revisor の変更系契約どおり workflow token と
  Concordia actor identity を付け、token 未設定・未登録・到達不能は明示的に失敗する。
- Revisor からの未検証データやエラー本文をブラウザへ素通ししない。
