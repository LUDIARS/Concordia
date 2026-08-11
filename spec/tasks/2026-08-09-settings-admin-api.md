---
task: settings-admin-api
project: Concordia
kind: 実装
status: done
created: 2026-08-09
source_session: lictor-cda8a337-d0f2-47ee-aa8a-639329b9fd55
memoria_task_id: null
actio_task_id: null
memory_links:
  - spec/setup/config-reference.md
---
# GET / PUT /v1/admin/settings (W5-2)

## 目的

W5-1 のレジストリを HTTP に出し、 WebUI から設定を読み書きできるようにする。
トークン等の secret を API に漏らさないことがこのタスクの譲れない要件。

前提: `2026-08-09-settings-registry-core.md`。

## 完了条件

- `GET /v1/admin/settings` がレジストリ全体をセクション付きで返す。
  各項目に 現在値 / 出所 (`db|env|default|none`) / 既定値 / env 名 / 説明 / 型 が含まれる。
- **secret 系は値を返さず `set: true|false` だけ返す**。 マスク済み文字列も返さない
  (先頭数文字だけ等も不可)。 これはセキュリティ要件で緩めない。
- `PUT /v1/admin/settings` がキー単位で更新する。 未知キーは 400 で拒否 (無言 no-op にしない)。
- 更新は既存 AdminState (`schema_meta` 永続化) 経路へ載せ、 新しい保存先を作らない。
- テスト (vitest) が green:
  - secret 系が値を返さず `set` フラグだけ返す
  - GET が全項目を返す / PUT がキー単位で更新する
  - 現在値の出所 (`db|env|default|none`) が正しく出る

## スコープ (編集可ディレクトリ)

- `src/api/` (admin settings ルータ。 既存 admin ルータへの追加または新規ファイル)
- `src/config/` (レジストリ側に読み取り API が必要な場合のみ)
- `tests/`
- `spec/tasks/` (この md)

## 設計上の注意

- ルータ / シリアライズ / 更新適用 を 1 ファイルに詰め込まない (SRP)。
- 既存の admin API の認証・信頼境界に合わせる
  (`spec/setup/config-reference.md` §信頼境界。 loopback 前提を勝手に広げない)。
- 未知キーや型不一致は fail-fast で 400。 黙って握らない。
