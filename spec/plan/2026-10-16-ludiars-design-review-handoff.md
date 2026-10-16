---
title: LUDIARS 9 ツール設計レビュー (Fable 支店) — 残作業引き継ぎ
id: CC-LUDIARS-DESIGN-REVIEW-HANDOFF
type: plan
status: planned
service: concordia
domain: governance
updated: 2026-10-16
---

# LUDIARS 9 ツール設計レビュー — 残作業引き継ぎ資料 (Fable 支店)

- 作成: 2026-10-16 (セッション停止時点)
- セッション: https://claude.ai/code/session_019iVeE9PpCKpz3rRvEiC2XG
- 対象: Actio / Anatomia (An) / Augur / Breviarium (Br) / Concordia (Cc) / Conflux (Cf) / Genius (Gn) / Praeforma (Pf) / Revisor (Rv)
- 状態: 提案文書・実装は **9 リポとも未着手**。本資料と途中成果物だけを Concordia に置いた。

---

## 1. 依頼内容

1. AI 開発を支える 9 ツールの設計レビュー。ドメイン的な関連性での重複・無駄、管理の手間、アクセスのボトルネックを見つけ、より高次元・高速に最適化する。まず確認し、Fable 支店として改善提案を作る。
2. 提案は **それぞれのリポジトリにコミット** する。
3. **実装できるところは Opus に実装させる**。
4. 実装が終わったら **レビュー** する。
5. セッション 8:55 に作業を止めて残作業を報告する (→ 実際には週次上限と「全作業停止」で先に停止)。

## 2. 現在地

| 段階 | 状態 | 備考 |
|---|---|---|
| 0. 事前スカウト | 完了 | 9 ツールの位置づけ・共有規約・通信辺の件数・ツールチェーン一覧 |
| 1. リポ別マップ (10 体) | **3/10 完了** | Actio / Anatomia / Breviarium。残り 7 体は週次上限で失敗 |
| 1'. 横断スカウト (2 体) | 未完 | 横断的関心の再実装 / 台帳・サービス発見・通知・呼び出し辺 |
| 2. 横断分析 + 反証検証 | 未着手 | スクリプトは作成済み (`analyze.js` / `verify.js`) |
| 3. リポ別提案文書 (9 本) | 未着手 | 置き場所・体裁は決定済み (§6) |
| 4. Opus による実装 + レビュー | 未着手 | 対象の選定基準は決定済み (§6) |
| 5. コミット → push → PR (9 リポ) | 未着手 | — |

**停止理由**: サブエージェントの週次利用上限 (「You've hit your weekly limit · resets 12am (UTC)」)。Workflow 内のエージェント 9 体が起動直後に失敗。直後に「全作業停止」の指示。

## 3. 成果物の所在

本資料と同じ階層の `2026-10-16-ludiars-design-review-handoff/` に置いた (Concordia `feat/ludiars-design-review-handoff` ブランチ)。

| ファイル | 内容 |
|---|---|
| `2026-10-16-ludiars-design-review-handoff/map-Actio.json` | Actio の構造化マップ (目的・概念・統合・配備・再実装・痛点・重複疑い・ボトルネック、根拠付き) |
| `2026-10-16-ludiars-design-review-handoff/map-Anatomia.json` | Anatomia 同上 |
| `2026-10-16-ludiars-design-review-handoff/map-Breviarium.json` | Breviarium 同上 |
| `2026-10-16-ludiars-design-review-handoff/notes-fable.md` | Fable が直接確認した事実 (submodule 版ずれ、共有 lib 配布 3 方式、Node 版、spec フォルダ実態、既存自己分析文書) |
| `2026-10-16-ludiars-design-review-handoff/ludiars-understand-split.js` | 第 1 段 Workflow (リポ別リーダー 10 体 + 横断スカウト 2 体)。`args.readers` / `args.scouts` で部分実行 |
| `2026-10-16-ludiars-design-review-handoff/make-digests.mjs` | マップ + スカウト出力から次元別ダイジェスト (D1〜D6) を生成 |
| `2026-10-16-ludiars-design-review-handoff/analyze.js` | 第 2 段 Workflow: 6 次元の分析 (所見 + 提案 + implementNow 判定) |
| `2026-10-16-ludiars-design-review-handoff/verify.js` | 第 2 段 Workflow: 所見バッチごとに 2 レンズ (根拠検証 / 反論と提案批評) の反証検証 |

Workflow スクリプトの `WF` 定数は作業時の scratchpad パスを指している。再開時はマップを置いたディレクトリに書き換える。週次上限で失敗した 10 体は構造化出力も所見メモも残しておらず (ファイル読み取りのみ)、再実行が前提なので生トランスクリプトは含めていない。

## 4. 既に得られている所見の種 (再開時の出発点)

3 リポのマップと直接確認から、横断所見になりそうなものを先に並べる。いずれも **第 2 段で反証検証してから** 提案にする。

### 4.1 ドメイン / 台帳の重複
- **プロジェクト台帳が少なくとも 8 系統**: Cc `project_codes` (略称 At 等) / Excubitor catalog `project_code` (actio / Br / Cf / Gn … 表記ゆれ) / An `projects.json` (`${ARS_ROOT}/.anatomia`) / Augur `repositories.json` / Rv repository registration / Pf projects (ULID) / Cf workspaces / Actio `project_refs`。Br は 1 プロジェクトにつき最大 7 つの binding (Pf id / Elegantia product / Voluptas path / githubRepo / Actio code / An project / Ex service) を **人が手入力** する (Br README:63,128-134、spec/feature/project-registry.md:21-29)。
- **作業単位の台帳が三重**: Actio tasks / Cc delegation run / `spec/tasks/*.md` frontmatter (actio_task_id・delegation_run_id・source_session)。An の RefactoringTask はさらに Memoria / Cc の切替 sink (An src/adapters/refactoring-task-sink.ts:49-54)。
- **テスト↔要求の対応が 3 系統**: `cc.acceptance.json` (AT-*) / `augur.contracts.json` (C-n) / `.augur/tests.jsonl`。Br は 46 契約を宣言しつつ log-weaver 非注入で全件 uncovered、代わりに手動テストで述語を検証する二重運用 (Br spec/tasks/2026-09-26-breviarium-cf-access.md:117-119)。
- **PR / マージ情報の二重取得**: Br は Rv CLI (8 プロセス直列) と Cc `/v1/prs` の両方から取り PR 番号で突合 (Br src/inspections/domain/merged-prs.ts)。Actio の PR 証跡は Cc が書き Actio は表示のみ。
- **cost ドメインの二重所有**: An が cost の受信ハブ (`POST /api/cost-feed`、プロセス内 latest-wins で再起動で消える) と送信元 (Cc `/v1/cost/one-shots`) と推定器 (単価表) を兼ねる (An spec/data/cost-feed.md:1-4、src/providers/concordia-cost.ts)。
- **スプリント健全性の定義が Actio の外**: Actio が正本のスプリントに対し消化率・経過率・A〜D は Br 側で計算し、Actio は Br 専用の集計 API を持つ (Actio modules/task/team/project-routes.ts:5、Br spec/feature/sprints.md:80-114)。
- **Anatomia の所属率を Br が再計算**: Br は spec/domains/*.domain.json の pathPattern を git index に自前で当てる (Br src/inspections/domain/membership-coverage.ts)。An が所属率を API/CLI で出せば不要。
- Actio 内部: Calliope とのスプリント二重実装 (承知の上)、Group (レガシー) と Team の併存、PM (pm_tasks) と core tasks の分離、Memoria 互換層の残存。

### 4.2 コードの重複 (横断的関心の再実装)
- **Br は Cf の HTTP 基盤を丸ごと写した** (router / host-origin-guard / node-server / escape / contract-types / health / JSON 保存): Br spec/tasks/2026-09-26-breviarium-foundation.md:63-67。共有パッケージ化は「実行時依存なし」方針で不採用。
- **Cloudflare Access JWT 検証が 3 リポ目**: Elegantia → Lares → Br (Br spec/tasks/2026-09-26-breviarium-cf-access.md:17-18,72-76)。Actio も `src/auth/cf-access-verify.ts` で独自実装 (4 つ目)。Cc も management 入口で Access JWT 必須。
- **他サービス URL 解決の規則が各自**: Br `BREVIARIUM_<X>_URL > <X>_URL`、Cf `CONFLUX_CC_URL > CONCORDIA_URL`、Actio は secretManager.get を 10 箇所以上、An は 4 つの独立した解決器で `127.0.0.1:11111` ハードコード (An src/providers/concordia-cost.ts:24-26) と `../Augur` パス依存 (src/adapters/augur.ts:19-20)。
- **契約 runtime の配布が 6 通り**: Augur templates から各リポへ生成コピー (Actio / Genius / Rv / An / Cc) と、依存に無い `@ludiars/log-weaver` を importFrom に書くだけ (Br / Cf / Pf)。
- **excubitor.catalog.yaml の独自パーサ**: Br (行単位、ライブラリなし) と Rv `src/catalog.mjs`。
- **semver Release 分類** を Br が Rv の `classifyReleaseKind` と同じ規則で再実装 (Br src/workflow/domain/explicit-release.ts)。
- Actio 内部: URL 妥当性検証の 1 行が 6 箇所にコピー、`isRunning` + setInterval + unref の常駐 tick が 5 箇所、OpenAI 互換クライアントが 2 箇所、DDL が Drizzle + dialect 別手書き + tests/helpers.ts の多重管理。
- An 内部: Redis クライアント 2 実装 (無言 no-op vs 警告 + fallback)、直列ジョブキュー 2 本、JSONL ログ 4 系統。

### 4.3 管理の手間
- **共有 lib の配布方式が 3 種** (submodule / コミット済みコピー / 生成コピー) と **submodule の版ずれ**: Lapilli が 3 commit (Cc=Rv 07f1629 / Pf 634003e / An 98ed6a2)、Vestigium が 3 commit (Cc afe7ca5 / An 802e231 / Actio c38da49)。
- **Node 版の表記が 5 通り以上**: Br/Cf >=24、Gn >=22、Cc/Rv >=22.12、Augur >=20、Actio (.nvmrc 24.14.1 / README v22+ / Dockerfile node:22 / SETUP v18+)、An README 20+。テストランナも vitest と node --test に分裂、lint は Augur のみ。
- **ビルド鎖**: Actio は dev/build/typecheck/test の全 pre フックで packages/sdk と lib/terpsichore を tsc、submodule 未取得で TS5058。An は submodule init → native build (kuzu は本番未使用) → build の 3 段。Br は An の dist build 済みを前提に CLI を叩く。
- **設定・secret の層**: Actio は 5 層 (catalog env / EXCUBITOR_SERVICE_CONFIG_JSON / 暗号化ローカル config / Vault secret-agent / 旧 SSM) + 初回設定画面。An はほぼ env 直読み約 50 変数で統一 loader なし。
- **ドキュメント腐敗**: Actio の README / CLAUDE.md / MODULES.md / SETUP.md が分離前の構成を説明 (modules/ に event/calendar/… は存在しない)。An は MCP 11 vs 実装 17 ツール、CLI 21 vs 24、CLAUDE.md の spec 許可フォルダ 5 vs 実態 10。
- **spec/ フォルダ規約の乖離**: An CLAUDE.md は data/feature/interface/setup/test 以外を禁止と書くが、Br/Cf は architecture/domains/feature/tasks/ux、Cc は 13 フォルダ。CI の harness は AIFormat の `harness-checks.yml` を Castra が配信 (Cc だけ SHA 固定、他は @main)。
- Actio 固有の即効候補: `.claude/settings.json` の pre-push が別リポ Schedula の ci-check.sh を指す、`spec/domains/web-frontend.domain.json` の specRefs 重複キー、`src/index.ts` の文字化けログ、frontend Dashboard の `localhost:8080` ハードコード、`bash.exe.stackdump` のコミット、未使用の `@ludiars/schedula-module-*` 依存、review/ の root と日付フォルダの不整合。
- Br 固有: Linux で 2 テストが失敗 (Windows 絶対パス前提、tests/adapters/http-app.test.ts:274-277、tests/shared/contracts.test.ts:519-521)、env 名の互換エイリアス蓄積 (BR_REFRESH_INTERVAL_SEC、VOLPUTAS 綴り誤り)。

### 4.4 アクセスのボトルネック
- **Actio → Cc は全面ポーリング** (チーム/プロジェクト 10 分、スプリント判断 30 秒、チャット 30 秒、通知送信箱 1 分、PM 1 分)。Cc → Actio の push/webhook は無い (Actio modules/task/team/cc-sync.ts:23,120-140 ほか)。
- **Actio chat tick は単一 lease (300 秒) で全接続を直列処理**、その中で Cc 審査 70 秒 / LLM 60 秒 / Di 100 秒の外部呼び出し → 1 接続の遅延が全チームを止める (modules/task/chat/runtime.ts:22-38)。
- **An の CLI 経路は毎回 cold analyze** (card cache を通らず duplication ゲートが常に pass)、warm サーバは autostart false + 3h idle 自己終了、UserPromptSubmit で毎回 plan LLM ~10 秒、Augur ブリッジは HTTP 要求内で子プロセスを同期待ち (最大 10 分)。
- **Br の定期更新は 1 プロジェクトずつ直列**、1 プロジェクト内で Rv CLI 最大 8 × 60 秒直列 + An CLI 120 秒 (最大 600 秒) が律速 → 最悪 10 分超/プロジェクト。手動 refresh は全ソース完了まで同期、重なると 409。retry なし。gh は 5 秒で失敗すると「リリース済み」が永久に前回値。
- **Br は An / Rv を execFile で呼ぶ設計のため同一機でしか動かない** (checkout・dist build・gh ログイン・Voluptas データが同じ機械にある前提)。
- **Excubitor / Elegantia が `provides` を持たない** → Br の「運用中」判定と品質評価は既定構成で永久に未接続 (Br README:40,43)。どちら側で直すか未決。
- **公開入口**: Actio は 3 ホップ (cloudflared → actio-web:17881 → actio:17880) で CF Access 経由は全員 `actio-local` に畳まれ、Br 集計 API や Pf 実装確認が 403 になる。
- **初回セットアップ / テスト時間**: Actio テスト 2〜3.5 分直列 (app cold import ~7 秒/スイート)、An 255 ファイル 201 秒、Rv 上限 600 秒に対し余裕薄。
- 既知 (参照のみ): Cc 単一 SQLite・単一プロセス (spec/plan/refactor-3axis-architecture.md)、Cc 5 故障モード (cc-stability-analysis.md)、Rv ダッシュボード 3 秒ポーリング 21MB・Cc Test Forum 同期 2.2MB (2026-10-11-cc-rv-data-growth-audit.md)。

### 4.5 統合トポロジ
- 通信辺の機構が混在: HTTP (Actio↔Cc, Br→Pf/Cc/Actio/Ex/Elegantia, Pf→An, Cf→Cc) / CLI execFile (Br→An/Rv/gh, Rv→An/Augur/Codex, An→Augur/claude) / MCP stdio (An) / hooks (Castra→An) / Discord 直接 (Rv webhook 直送化、Actio 直接モード、An 添付取得) / env 注入 (Ex provides)。
- 「Cc 側未定義」「未接続」の辺: Cf の 4 経路 (spawn / lookup / build / identity)、Br の Ex / Elegantia / Cf 成果物、An の task sink (MEMORIA_TASK_URL / CONCORDIA_TASK_WORKFLOW_URL)、Actio の Jev / Genius 配備設定。
- AI 支援ツールが計画段階で効いていない記録: `augur plan` が毎回汎用提案 1 件、An `test-suggestions` サブコマンド不在 (Br 6 タスクすべてで「タスク本文のテスト一覧に沿って計画」)。

## 5. 残作業の手順

### Step 1. 残りのマップと横断スカウト
同一セッションで再開する場合 (キャッシュが効く):
```
Workflow scriptPath=/root/.claude/projects/-home-user/32afae0b-127d-59be-8436-fc8b058671df/workflows/scripts/ludiars-understand-split.js
  resumeFromRunId=wf_3eb5aa16-81f  args={"readers":["read:Actio","read:Anatomia","read:Augur","read:Breviarium"],"scouts":false}
Workflow scriptPath=同上 args={"readers":["read:Concordia-domains","read:Concordia-integrations","read:Conflux","read:Genius"],"scouts":false}
Workflow scriptPath=同上 args={"readers":["read:Praeforma","read:Revisor"],"scouts":true}
```
新しいセッションの場合: `2026-10-16-ludiars-design-review-handoff/ludiars-understand-split.js` を Workflow の `script` として渡し、`args.readers` から完了済みの `read:Actio` / `read:Anatomia` / `read:Breviarium` を外す (3 本に分けて並列起動。Workflow の同時実行枠は CPU 4 コアで 2 なので、1 本にまとめると直列になる)。

結果の保存: 各 Workflow の戻り値 `repoMaps[]` を `map-<Repo>.json`、`duplicatedInfra` を `scout-duplicated-infra.json`、`registriesAndEdges` を `scout-registries-and-edges.json` として `wf/` ディレクトリに置く (journal.jsonl の `{"type":"result"}` 行からも取れる)。

### Step 2. ダイジェスト生成
```
node 2026-10-16-ludiars-design-review-handoff/make-digests.mjs <wf ディレクトリ>
```
→ `digest-d1-domain-overlap.md` 〜 `digest-d6-quick-wins.md` が出来る。

### Step 3. 横断分析 (6 次元)
`analyze.js` の `WF` 定数を wf ディレクトリに合わせてから、2 次元ずつ 3 本並列:
```
Workflow script=analyze.js args={"dimensions":["d1","d2"]}
Workflow script=analyze.js args={"dimensions":["d3","d4"]}
Workflow script=analyze.js args={"dimensions":["d5","d6"]}
```
各所見は `id / title / claim / evidence[] / affectedRepos / severity / proposal{owner, steps, effort, acceptance} / implementNow{feasible, repo, files, verification}` を持つ。d6 は Opus 実装対象の候補 (全件 implementNow=true)。

### Step 4. 反証検証
所見を主リポごとに 4〜6 件のバッチにまとめ、`verify.js` に `args.batches=[{name, findings:[…]}]` で渡す (3 本並列)。verdict が `refuted` の所見は落とし、`weakened` は severity と提案を訂正して採用。`implementNowOk=false` のものは実装対象から外す。

### Step 5. 提案文書の執筆 (9 本)
§6 のテンプレートで各リポに `spec/plan/2026-10-15-ludiars-design-review-fable.md` を書く。構成: (1) 全体像 (共通節、9 本で同じ) (2) このリポに固有の所見と提案 (3) 横断提案の中でこのリポが担う役割 (4) 今回実装した項目と検証結果 (5) 未検証・保留。

### Step 6. Opus による実装 → レビュー
- 対象: d6 の候補のうち検証で `implementNowOk=true` のもの。1 リポ 1 エージェント (`model: "opus"`)、リポ内で直列に実装。
- 各エージェントの完了条件: 変更ファイル一覧、実行した検証コマンドと結果 (typecheck / test)、変更しなかった理由。
- 実装後に別エージェント (または `/code-review`) で差分レビューし、所見を反映してから次へ。
- 検証の制約: Concordia / Actio / Anatomia / Praeforma は `lib/*` submodule 未取得のため typecheck・test が通らない可能性がある。その場合は提案文書と PR 本文に「未検証」と明記 (詳細 §7)。

### Step 7. コミット → push → PR (9 リポ)
```
git -C /home/user/<Repo> checkout -b feat/ludiars-design-review-fable
git -C /home/user/<Repo> add spec/plan/2026-10-15-ludiars-design-review-fable.md <実装ファイル>
git -C /home/user/<Repo> commit   # 末尾に Co-Authored-By / Claude-Session 行
git -C /home/user/<Repo> push -u origin feat/ludiars-design-review-fable
```
PR は ready for review で作成し (GitHub MCP `create_pull_request`)、作成後に `subscribe_pr_activity` で監視。PR 本文は §付録 C。

## 6. 決定済み事項

- **提案文書の置き場所**: 全リポ共通で `spec/plan/2026-10-15-ludiars-design-review-fable.md`。9 リポ中 7 リポに `spec/plan/` が既存 (Actio / Anatomia / Augur / Concordia / Genius / Praeforma / Revisor)、Breviarium / Conflux は新設。Concordia / Augur / Genius の既存 plan 文書に倣い OKF frontmatter (`type: plan`, `status: proposed`) を付ける。
- **PR 方針**: 各リポ 1 ブランチ `feat/ludiars-design-review-fable` → 1 PR (提案文書 + 実装分を集約。LUDIARS 運用「AI 実装は 1 PR に集約」)。main 直 push 禁止、squash merge 前提。
- **Opus 実装の基準 (implementNow)**: 単一リポで閉じる / 振る舞いを変えない / typecheck・テストで検証できる / 30 分以内。例: 設定・ドキュメントの乖離修正、死んだ依存・コードの除去、ハードコード既定値の env 化、重複キー修正、timeout 未設定の明示化、health ルート追加。ポーリング間隔・timeout 値・認可の変更、共通パッケージ抽出、他リポとの同時配備が要るものは **提案に留める**。
- **既存の自己分析文書と重複する所見は「既知 (参照)」として短く扱う**: Cc の 3 軸分離計画・安定性分析・データ増大監査、Cc Node 原則、An の LLM クエリ計画。

## 7. 制約・注意

- **利用上限**: サブエージェントの週次上限は 12am UTC にリセットの表示。再開前に 1 体だけ試して確認する。
- **Workflow の同時実行枠は 2** (CPU 4 コア → min(16, 4−2))。長い処理は 3 本の Workflow に分けて起動する。
- **submodule 不在**: Concordia (`lib/vestigium`, `lib/lapilli`)、Anatomia (`lib/vestigium`, `lib/lapilli`, `lib/aiformat`)、Actio (`lib/vestigium`, `lib/terpsichore`)、Praeforma (`lib/lapilli`)、Revisor (`lib/lapilli`) が未チェックアウト。Lapilli / Vestigium / Terpsichore / AIFormat はこのセッションのリポ範囲外。`npm ci` は Augur / Genius / Revisor / Breviarium / Conflux で成功、Concordia は失敗 (`lib/vestigium/package.json` 不在)、Actio / Anatomia / Praeforma は未実行。実装を検証するには `add_repo` で Lapilli / Vestigium 等を追加するか、検証できない旨を PR に明記する。
- **Node**: コンテナは v22.22.0。Breviarium / Conflux は engines >=24 (EBADENGINE 警告のみ、`node src/main.ts` の型注釈剥がしは 22.22 でも動く見込みだが未確認)。Breviarium は Linux で既知の 2 テスト失敗あり (§4.3)。
- **Bash で `cd` すると作業ディレクトリが変わる** (Claude アプリが開ける範囲が変わる)。絶対パスか `git -C` を使う。
- **GitHub MCP が断続的に切断される**。PR 作成前に ToolSearch で再ロードする。
- **コンテナは一時的**。作業の成果は各リポにコミット・push してから終える。

## 8. 見積り (同時実行 6 体前提)

| 段階 | 目安 |
|---|---|
| Step 1 残りマップ + スカウト | 25〜35 分 |
| Step 2〜4 分析 + 検証 | 40〜60 分 |
| Step 5 提案文書 9 本 | 30〜45 分 (執筆は主セッション) |
| Step 6 Opus 実装 + レビュー | 60〜120 分 (件数次第、検証環境の制約あり) |
| Step 7 コミット + PR | 20 分 |

---

## 付録 A. 提案文書テンプレート

```markdown
---
type: plan
title: "LUDIARS 9 ツール設計レビュー (Fable 支店) — <Repo> 分"
description: "ドメイン重複・管理負荷・アクセスのボトルネックの横断レビュー。<Repo> に固有の所見と、横断提案で <Repo> が担う役割。"
service: <service code>
domain: architecture
status: proposed
tags: [design-review, cross-service, fable]
updated: 2026-10-15
---

# LUDIARS 9 ツール設計レビュー (Fable 支店) — <Repo> 分

## 1. 全体像 (9 リポ共通)
- レビューの目的・方法 (リポ別マップ → 6 次元分析 → 2 レンズ反証検証)
- 横断所見の要約 (台帳の多重化 / 横断的関心の再実装 / 配布・ツールチェーンのばらつき / ポーリングと直列 CLI / Cc・An へのハブ集中)
- 横断提案の優先順位 (正本の一本化 → 共通カーネルの配布方式統一 → イベント配送の push 化 → …)

## 2. <Repo> に固有の所見
| ID | 所見 | 根拠 | 深刻度 | 検証結果 |

## 3. <Repo> への提案
各提案: 何を / 正本はどこ / 手順 / 受入条件 / 工数 / リスク / 代替案

## 4. 横断提案の中で <Repo> が担う役割

## 5. 今回実装した項目と検証結果
| 項目 | 変更ファイル | 検証コマンド | 結果 |

## 6. 未検証・保留・次のアクション
```

## 付録 B. Opus 実装エージェントへの指示テンプレ

```
対象リポ: /home/user/<Repo> (ブランチ feat/ludiars-design-review-fable は主セッションが作る。あなたは作業ツリーだけ変更)
実装する項目 (検証済み所見 d6-xx …): <所見の claim / files / changeSummary / verification を貼る>
ルール: リポの CLAUDE.md / AGENTS.md に従う。振る舞いを変えない。無言フォールバックを足さない。any 禁止 (Actio)。
       1 項目ごとに typecheck とテストを実行し、結果を記録。submodule 不在で実行できない検証はその旨を記録。
       実装しない判断をした項目は理由を書く。
返すもの: {変更ファイル一覧, 項目ごとの検証コマンドと結果, 実装しなかった項目と理由}
```

## 付録 C. PR 本文テンプレ

```
## 概要
LUDIARS 9 ツール設計レビュー (Fable 支店) の <Repo> 分。提案文書 spec/plan/2026-10-15-ludiars-design-review-fable.md と、
検証済みの小さな改善 N 件を含む。

## 実装した項目
- <項目>: <変更ファイル> — 検証: <コマンド> → <結果>

## 検証できなかったこと
- <submodule 不在 / 実サービス未起動 など>

## 関連
- 他 8 リポの同名 PR

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_019iVeE9PpCKpz3rRvEiC2XG
```
