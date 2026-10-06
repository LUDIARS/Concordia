---
task: federation-tailnet-site-provision
project: Concordia
kind: 実装
created: 2026-10-06
memory_links: []
---
# 連合拠点を tailnet で繋ぎ、Excubitor 依頼で拠点設定を入れる

## 目的

neco 指示 (2026-10-06)「Ccの連合拠点実装と設定をやる」。本社の連合 listener は Tailscale のアドレスに
平文 ws で bind 済みだったが、拠点クライアントが loopback 以外への平文 ws を拒否するため、
登録済みの拠点はどれも一度も繋がっていなかった。拠点 Cc の拠点設定 API は loopback 限定で、
拠点の外から設定を入れる経路も無かった。

設計判断 (neco 回答): A = tailnet 平文 ws を許可、B1 = Excubitor 依頼で設定投入。

## 完了条件

- CC-FED-T1: 拠点クライアントは平文 ws を loopback / tailnet IP 宛てだけ許す。
- CC-FED-T2: 本社 listener は loopback / tailnet 以外の接続元を hello 前に切る (env で外せる)。
- CC-FED-T3: 拠点設定の保存時点で T1 に反する hq_url を 400 にする。
- `tools/federation-provision-site.mjs` で、本社登録 → Excubitor 依頼 → 完了待ち → 接続表示ができる。token は出力しない。
- 本社と拠点 (GROMAC / MELPOT / VANMAC) へ反映し、本社の `/v1/federation` で online を確認する。

## スコープ

- `src/federation/` (transport-policy / site-client / hq-listener / listener-settings / env / runtime)
- `tools/federation-provision-site*.mjs`、`tests/federation-link.test.ts`
- `spec/feature/federation-link.md`、`spec/setup/`、`spec/plan/multi-site-federation.md`、`spec/domains/federation.domain.json`、`cc.acceptance.json`

## 関連

- Excubitor #2499 (依頼 `concordia-federation-site`)、#2500 (Excubitor 自身の更新が submodule の中身の変化で止まる不具合)

## 残作業

- 拠点の Excubitor の初回更新は、拠点側の未コミット変更 (lib/lapilli) を人間が戻す必要がある。
