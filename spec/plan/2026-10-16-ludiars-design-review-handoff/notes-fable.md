# Fable 自身が直接確認した事実 (2026-10-15)

## 共有ライブラリの配布方式が 3 種類ある
- git submodule: Concordia lib/{vestigium,lapilli}、Anatomia lib/{vestigium,lapilli,aiformat}、Actio lib/{vestigium,terpsichore}、Praeforma lib/lapilli、Revisor lib/lapilli (.gitmodules)
- 委譲先 commit の版ずれ (git submodule status):
  - Lapilli: Concordia 07f1629 / Revisor 07f1629 / Praeforma 634003e / Anatomia 98ed6a2 (3 系統)
  - Vestigium: Concordia afe7ca5 / Anatomia 802e231 / Actio c38da49 (3 系統)
- コミット済みコピー (dist 込み): Concordia lib/{aop-metrics,blackbox,memory} (.gitignore で /lib/* を除外しつつ !/lib/aop-metrics/** 等で個別許可)
- Augur の templates/contract-runtime/contract-runtime.{ts,mjs} から各リポへ「生成コピー」 (Actio src/contract-runtime.ts, Genius src/contract-runtime.ts, Revisor src/contract-runtime.mjs, Anatomia src/adapters/web/contracts/runtime.ts, Concordia src/harness/reliability/contracts/ontime-runtime.js)。Breviarium / Conflux / Praeforma は `@ludiars/log-weaver` を importFrom に書くが package.json の依存には無い (Breviarium/Conflux は依存ゼロ)
- GitHub Packages npm: Actio の @ludiars/cernere-* / @ludiars/schedula-*

## npm ci の結果 (この環境、Node v22.22.0 / npm 10.9.4)
- Augur / Genius / Revisor / Breviarium / Conflux: 成功 (Breviarium / Conflux は engines >=24 で EBADENGINE 警告)
- Concordia: 失敗 — lib/vestigium/package.json が無い (submodule 未初期化)。scripts/bootstrap.mjs が submodule init + Vestigium build + npm ci を順に行う前提
- Actio / Anatomia / Praeforma: lib/ submodule が無いと prebuild / file: 依存で失敗する見込み (未実行)

## Node 版 (package.json engines / 実態)
- Augur >=20、Genius >=22、Concordia >=22.12.0、Revisor >=22.12.0、Breviarium >=24、Conflux >=24、Actio (.nvmrc 24.14.1 / README v22+ / Dockerfile node:22 / SETUP v18+)、Anatomia README 20+、Praeforma 未指定
- 起動形態: dist 起動 (Actio, Anatomia, Concordia, Genius, Praeforma) / src 直起動 (Breviarium, Conflux: `node src/main.ts` 型注釈剥がし / Revisor: src/cli.mjs / Augur: bin/augur.mjs)
- テストランナ: vitest (Actio, Anatomia, Augur, Concordia, Genius, Praeforma server) / node --test (Breviarium, Conflux, Revisor)
- lint: eslint は Augur のみ、Concordia は dependency-cruiser + tsc

## spec/ フォルダ構成 (ls spec)
- Actio: README data domains feature interface plan schema setup tasks ux verification
- Anatomia: README architecture data domains feature interface plan setup tasks test ux
- Augur: data design.md domains feature implementation-design.md interface media-tool-implementation.md plan roadmap.md setup tasks test
- Breviarium: architecture domains feature tasks ux
- Concordia: README architecture data design domains faq feature interface plan setup tasks test ux
- Conflux: architecture domains feature tasks ux
- Genius: data domains feature interface plan setup tasks test
- Praeforma: data domains feature interface plan schema setup tasks test verification
- Revisor: architecture.md domains feature plan tasks
- Anatomia CLAUDE.md は data/feature/interface/setup/test 以外を禁止と書くが、実態は 10 フォルダ。CI の harness は LUDIARS/AIFormat の harness-checks.yml (Castra が配信、Concordia は特定 SHA 固定、他は @main)

## Excubitor catalog の project_code 表記ゆれ
- actio / anatomia / augur / Br / concordia / Cf / Gn / praeforma / revisor (小文字フルネームと略称が混在)。Actio の Cc project code は At

## 既存の自己分析文書 (重複レビューを避けるため参照)
- Concordia spec/plan/refactor-3axis-architecture.md (42k 行・54 テーブル・単一プロセスの 3 軸分離計画、V1〜V14 の結合違反)
- Concordia spec/plan/cc-stability-analysis.md (2026-07-09、Fable 調査、5 故障モード)
- Concordia spec/plan/2026-10-11-cc-rv-data-growth-audit.md (Cc/Rv の遅延とデータ増大: Rv ダッシュボード 3 秒ポーリングで 21MB 応答、Cc Test Forum 同期が全履歴 2.2MB 取得)
- Concordia spec/architecture/nodejs-service-principles.md (CC-NODE-01〜10)
- Anatomia docs/plan-llm-query-support.md (2026-07-03 Fable 評価)
