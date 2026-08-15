---
task: federation-role-settings
project: Concordia
kind: 実装
created: 2026-08-09
memory_links: []
---
# 連合ロールの有効化を Cc 設定で完結させる

## 目的

listener / 拠点クライアントの有効化が env 依存で、env 注入は Excubitor が担っていたため、
連合が実質 Excubitor 依存になっていた (2026-08-09 neco 指示)。設定の正本を Cc の
schema_meta に移し、env は代替手段に落とす。

## 完了条件

- listener の enabled / port / host、拠点の hq_url / site_id / token が DB→env→既定で解決される。
- `GET/PUT /v1/federation/listener` と `GET/PUT /v1/federation/site` で読み書きでき、
  PUT は張り替え後の実状態を返す。
- 設定変更が再起動なしで反映される (既定 10 秒の同期)。
- 拠点トークンは暗号化保存され、API から平文が返らない。
- `enabled=true` かつポート未指定は 400。3 値が揃わない拠点設定は warn を出して起動しない。

## スコープ (編集可ディレクトリ)

- `src/federation/env.ts`, `src/federation/listener-settings.ts`, `src/federation/runtime.ts`
- `src/federation/listener-settings.test.ts`, `src/api/federation.ts`, `src/api/federation.test.ts`
- `src/bootstrap/core.ts`, `spec/feature/`, `spec/setup/federation.md`, `spec/setup/config-reference.md`

## 残作業

- WebUI の設定画面への項目追加 (今回は API のみ)。
