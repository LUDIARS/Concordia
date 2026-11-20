---
task: gemini-neon-role
project: Concordia
kind: 実装
created: 2026-11-20T00:00:00.000Z
memory_links: []
---

# Gemini Neon を役割名 neon で組み込む

## 目的

neco 指示 (2026-11-20)「Gemini Neon を使えるようにしたので組み込みたい」。人間が選んだ方針は「Concordia に正式に組み込む」。
Gemini 4 Neon (API model ID `gemini-4-neon`) を役割名 `neon` で、role map・モデルカタログ・委託テンプレートから使えるようにする。
spec: `spec/feature/model-role-map.md` (CC-MODEL-ROLE-MAP、MRM-GEM-01..05)。

追加指示 (同日 neco):「agy に切り替えて」「Lictor と Concordia を agy に対応させる変更 これやって」「Delegation で Argon と Neon を指定できるようにして」「ベースは Neon です」。
Gemini 4 系は Antigravity CLI (`agy`) で起動し、Gemini 4 Argon も役割 `argon` で指定できるようにする。既定役割は Neon。

## 変更内容

- `src/model-catalog/role-policy.ts`: `INITIAL_GEMINI_ROLE_MODELS = { neon: "gemini-4-neon" }`。`initialRoleModel("neon")` でも引ける。
- `src/model-catalog/role-map.ts`: `roles.gemini` を追加。Claude と同じ決め方を `pickCatalogFamilies` に切り出して共用する (MRM-GEM-01)。
- `src/model-catalog/template-model-role.ts` (+ contract): 役割名 `neon` を provider `gemini` で解決する。`[1m]` は Claude だけ (MRM-GEM-02)。
- `src/model-catalog/seed.ts`: カタログの現行行に `gemini-4-neon` (sort_order 5)。
- `src/delegation/seed.ts`: 実装委託テンプレート `neon` (Gemini Neon、💎、sort_order 28) (MRM-GEM-03)。

### agy / Argon / 既定 Neon (追加分)

- provider `agy` を追加: `src/control/spawner.ts` (SpawnProvider)、`src/db/delegation-repo.ts` (DelegationProvider)、
  `src/discord/delegation-template-cache.ts`、`src/mcp/delegation-server.ts`、`src/control/provider-preset.ts` (表示名 Antigravity)、
  `src/discord/formatter.ts` (🪐)、Web (`web/src/api.ts` / `DelegationSpawnForm.tsx` / `Delegation.tsx` / `delegation/model.ts` / `DepartmentEditor.tsx`)。gemini は残す。
- セッション登録: `StartSchema` / MCP の provider に `antigravity-cli`、`toSpawnProvider("antigravity-cli") → "agy"`、`ProviderName` と provider registry (null)。
- 役割解決: `template-model-role.ts` で provider `agy` も系統 gemini、役割 `argon` を追加、agy の空 model は neon (MRM-GEM-04/05)。
  `resolveDelegationSpawn("agy", 空)` は `INITIAL_GEMINI_ROLE_MODELS.neon` を `--model` で付ける (role map を通らない直接 spawn 用)。
- `role-policy.ts` に `argon: "gemini-4-argon"`、`role-map.ts` の系統を `(neon|argon)`、カタログ seed に `gemini-4-argon` (sort_order 6)。
- 委託 seed: `neon` を provider `agy` に、`argon` (🔷、sort_order 29) を追加。
- `tests/delegation-regression.test.ts`: seed の call_name / sort_order 一覧に neon / argon を足す
  (PR #3950 初回審査の parttimer-review-scheduling 失敗は、この一覧が neon 追加に追随していなかったのが原因)。

## 受入条件

- 役割解決が純関数のテストで示されている (role-map.test / template-model-role.test / model-catalog seed.test / delegation seed.test)。
- モデル ID の直書きが `role-policy.ts` / model-catalog の `seed.ts` 以外に増えていない (テストの期待値を除く)。
- typecheck が通る見込みを差分で確認している (`RoleMap.roles` を組み立てるテストにも gemini を足した)。
- provider `agy` の委託は model 未指定でも `--model <neon の ID>` で起動し、`argon` は明示指定でだけ使われることがテストで固定されている
  (template-model-role.test / provider-preset.test / delegation seed.test / delegation-regression.test)。
- `antigravity-cli` のセッション登録が受理され、spawn 時は `agy` に写ることがテストで示されている (sessions/shared.test)。

## 範囲外

- Lapilli one-shot の Gemini 対応 (人間が今回は不要と判断)。
- Gemini CLI の更新、サービスの再起動・反映 (マージ後の build・再起動は親セッションが人間の許可を得て行う)。
- `gemini-4-hydrogen` / `gemini-3.8-flash`、agy の `--effort` 連携。

## 未確認

- 手元の Gemini CLI 0.36.0 には `gemini-4-neon` の名前が無く、`--model` で渡して動くかは未確認。agy 1.5.13 では `--model gemini-4-neon` / `gemini-4-argon` の応答を親セッションが確認済み。
- vitest・typecheck・build は人間の許可が無いため未実行。
