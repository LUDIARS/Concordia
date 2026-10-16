export const meta = {
  name: 'ludiars-understand',
  description: 'Map the 9 LUDIARS tools: purpose, concepts, integrations, deployment, pain points',
  phases: [
    { title: 'Read repos', detail: 'one reader per repository (Concordia split in two)' },
    { title: 'Cross-cutting scouts', detail: 'duplicated infra code, registries, service discovery' },
  ],
}

const ROOT = '/home/user'
const REPOS = ['Actio', 'Anatomia', 'Augur', 'Breviarium', 'Concordia', 'Conflux', 'Genius', 'Praeforma', 'Revisor']

const ECOSYSTEM = `
背景 (全エージェント共通):
- ${ROOT}/ 配下に LUDIARS の AI 開発支援ツール 9 リポジトリがある: ${REPOS.join(', ')}。
- 略称: Concordia=Cc, Anatomia=An, Augur, Revisor, Genius=Gn, Praeforma=Pf, Breviarium=Br, Conflux=Cf, Actio。
- リポ外の関連サービス (本レビューの対象外だが参照は記録する): Excubitor (サービス管理・catalog・Vault・topology env 注入), Cernere (認証), Elegantia, Voluptas, Memoria, Vestigium (ログ), Schedula, Aedilis, Nuntius, Tela, Lictor, Terpsichore。
- 各リポ共通の規約ファイル: excubitor.catalog.yaml (サービス定義・port・provides で他サービスへ URL を配る), augur.contracts.json (観測契約), augur.inject.json (ログ注入), cc.acceptance.json (source→tests→contracts 対応), lib/ (同梱 @ludiars/* パッケージ), spec/ (AIFormat 分類フォルダ)。
- レビューの目的: 9 ツール間のドメイン重複・無駄、管理の手間、アクセスのボトルネックを見つけ、より高次元・高速に最適化する改善提案を作る。あなたの出力はその材料になる。
- 出力は日本語。根拠は必ず「ファイルパス:行番号」または「ファイルパス」で示す。推測は「推測」と明記する。node_modules と dist は読まない。
- 最終テキストは人間向けメッセージではなく生データとして扱われる。前置き・挨拶は不要。
`

const REPO_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string' },
    abbreviation: { type: 'string' },
    purpose: { type: 'string', description: '1〜3 文。何のためのツールで、誰が (人/AI エージェント/他サービス) いつ使うか' },
    coreConcepts: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, definition: { type: 'string' }, storedIn: { type: 'string' }, evidence: { type: 'string' } }, required: ['name', 'definition'] } },
    responsibilities: { type: 'array', items: { type: 'string' } },
    interfaces: { type: 'array', items: { type: 'object', properties: {
      kind: { type: 'string', description: 'cli | mcp | http | ws | hook | file | discord | slack | web-ui' },
      description: { type: 'string' }, entry: { type: 'string' } }, required: ['kind', 'description'] } },
    dataStores: { type: 'array', items: { type: 'object', properties: {
      kind: { type: 'string' }, location: { type: 'string' }, holds: { type: 'string' }, evidence: { type: 'string' } }, required: ['kind', 'holds'] } },
    integrationsOut: { type: 'array', description: 'このツールが他のツール/サービスを呼ぶ経路', items: { type: 'object', properties: {
      target: { type: 'string' }, mechanism: { type: 'string', description: 'http | cli-execFile | mcp | file | discord | webhook | env-injection | git | other' },
      purpose: { type: 'string' }, syncOrAsync: { type: 'string' }, timeoutRetry: { type: 'string' }, evidence: { type: 'string' } }, required: ['target', 'mechanism', 'purpose', 'evidence'] } },
    integrationsIn: { type: 'array', description: '他のツール/サービスがこのツールを呼ぶ経路 (このリポの spec/コードから分かる範囲)', items: { type: 'object', properties: {
      source: { type: 'string' }, mechanism: { type: 'string' }, purpose: { type: 'string' }, evidence: { type: 'string' } }, required: ['source', 'mechanism', 'purpose', 'evidence'] } },
    deployment: { type: 'object', properties: {
      startCommand: { type: 'string' }, requiresBuild: { type: 'string' }, nodeVersion: { type: 'string' }, testRunner: { type: 'string' },
      port: { type: 'string' }, autostart: { type: 'string' }, healthCheck: { type: 'string' }, publicExposure: { type: 'string' },
      authMechanism: { type: 'string' }, configSources: { type: 'string', description: 'env / catalog / config file / Vault 等の設定の来歴' } } },
    sharedConventions: { type: 'object', properties: {
      augurContractsImportFrom: { type: 'string' }, augurInject: { type: 'string' }, ccAcceptance: { type: 'string' },
      libVendored: { type: 'array', items: { type: 'string' } }, specLayout: { type: 'string' }, reviewAndTaskDocs: { type: 'string' },
      architectureStyle: { type: 'string', description: 'DDD 層分け / レイヤ分割 / フラット 等' } } },
    crossCuttingReimplementations: { type: 'array', description: '他リポでも同様に実装されていそうな横断的関心 (host/origin guard, Cloudflare Access JWT, loopback 強制, 設定ローダ, health, 他サービス URL 解決, Discord/Slack 投稿, mention 無害化, contract runtime, JSONL ログ, retry/timeout, SQLite 初期化 等)', items: { type: 'object', properties: {
      concern: { type: 'string' }, file: { type: 'string' }, notes: { type: 'string' } }, required: ['concern', 'file'] } },
    painPoints: { type: 'array', items: { type: 'object', properties: {
      description: { type: 'string' }, kind: { type: 'string', description: 'known-issue | workaround | todo | planned-but-missing | perf | ops-burden' }, evidence: { type: 'string' } }, required: ['description', 'kind', 'evidence'] } },
    unconnectedOrPlanned: { type: 'array', description: '「未接続」「Planned」「後続で実装」など、設計上は存在するがまだ繋がっていない経路や機能', items: { type: 'object', properties: {
      description: { type: 'string' }, evidence: { type: 'string' } }, required: ['description', 'evidence'] } },
    overlapsSuspected: { type: 'array', description: '他ツールと責務/概念が重なっていると疑われる点', items: { type: 'object', properties: {
      withTool: { type: 'string' }, concept: { type: 'string' }, why: { type: 'string' }, evidence: { type: 'string' } }, required: ['withTool', 'concept', 'why'] } },
    accessBottlenecks: { type: 'array', description: '同期 CLI 呼び出し・直列処理・単一ハブ・長いタイムアウト・重い起動・手動手順など、速度やアクセス性を落とす箇所', items: { type: 'object', properties: {
      description: { type: 'string' }, evidence: { type: 'string' } }, required: ['description', 'evidence'] } },
    size: { type: 'object', properties: { srcFiles: { type: 'number' }, specLines: { type: 'number' }, notes: { type: 'string' } } },
  },
  required: ['repo', 'purpose', 'coreConcepts', 'responsibilities', 'interfaces', 'dataStores', 'integrationsOut', 'integrationsIn', 'deployment', 'sharedConventions', 'crossCuttingReimplementations', 'painPoints', 'unconnectedOrPlanned', 'overlapsSuspected', 'accessBottlenecks'],
}

const READ_GUIDE = `
読み方の指針:
1. README / CLAUDE.md / AGENTS.md / DESIGN*.md / spec/ (特に ux, architecture, feature, interface, setup, data, domains) / excubitor.catalog.yaml / augur.contracts.json / augur.inject.json / cc.acceptance.json / package.json を読む。
2. src (または server/) のディレクトリ構成を把握し、他サービスとの通信コード (fetch, execFile/spawn, MCP, Discord/Slack, webhook, env の *_URL / *_CLI) を grep で特定して根拠を取る。
3. spec 内の「未接続」「Planned」「TODO」「後続」「暫定」「迂回」「workaround」「known issue」「遅い」「timeout」を grep して painPoints / unconnectedOrPlanned に拾う。
4. 「どの概念 (project / repository / team / sprint / PR / domain / spec / evidence / acceptance / contract / session / task / notification) をこのツールが所有しているか、他のツールから借りているか」を必ず coreConcepts と overlapsSuspected に書く。
5. 量より精度。根拠のない主張は書かない。
`

phase('Read repos')

const readerJobs = [
  { label: 'read:Actio', repo: 'Actio', extra: `Actio は大きく (src 497 ファイル)、予定/カレンダー系は Schedula へ移植予定で本レビューの主対象ではない。重点: タスク管理 (modules/task, modules/pm), Concordia 連携 (cc project / team / sprint, modules/task/team/cc-project-*), Praeforma / Breviarium / Augur / Genius / Terpsichore との連携, 認証 (Cernere), 設定・起動の複雑さ (bootstrap, Excubitor Vault, 暗号化 config, SSM), CI (scripts/ci-check.sh), lib/ (terpsichore, vestigium)。MODULES.md, system-design-v1.1.md, spec/plan/cernere-migration.md, spec/feature/terpsichore.md, spec/feature/local-mode-cf-access.md, review/ を読む。` },
  { label: 'read:Anatomia', repo: 'Anatomia', extra: `重点: DESIGN.md, spec/feature/analysis-procedure.md, domain-* 系 spec, spec/interface/{cli,web,mcp}.md, src/ のレイヤ一覧 (dag/graph/spec/domains/supply/dynamic/integral/review/patterns/screens/modules/scenes/project/cache/cost/branch/fs/providers/plugins/adapters/web-cache)。他ツールからどう呼ばれるか (Revisor の PR 解析, Augur の domain 解析, Breviarium の CLI 呼び出し, Praeforma の API 取得, Concordia の src/anatomia) を spec と src/adapters から特定。registry (projects.json / --home) と cache の所在。LLM backend 設定 (claude -p / anthropic / stub)。docs/measurement-report.md, docs/self-analysis.md, TASKS.md も読む。` },
  { label: 'read:Augur', repo: 'Augur', extra: `重点: README, spec/plan/test-management.md, spec/plan/daemonless-cli.md, spec/interface/{review-plan-cli,cli,http-api,tests-api,inject-cli,revisor-verification}.md, spec/feature/{log-injection,test-lifecycle,test-authoring,experience-driven-constraints}.md, spec/data/{test-registry,core-schema,persistence}.md, spec/implementation-design.md, templates/contract-runtime/, scripts/inject-logs.ts。全リポに augur.contracts.json / augur.inject.json がある理由と、contract runtime の配布方法 (templates からコピー? @ludiars/log-weaver?) を特定。Revisor / Anatomia / Praeforma / Concordia との関係。` },
  { label: 'read:Breviarium', repo: 'Breviarium', extra: `重点: README, spec/architecture/overview.md, spec/feature/{workflow,grading,snapshots,sprints,project-registry,web-entrance,web-ui}.md, spec/ux/product.md, spec/tasks/*, src/adapters/sources/* (14 ソースの取得方法: HTTP / CLI execFile / git / gh), src/adapters/http/{host-origin-guard,cloudflare-access-*,health}.ts, src/adapters/config/*。「未接続」のソース一覧、直列 refresh と timeout、Anatomia/Revisor CLI を execFile で呼ぶ設計の理由と制約。` },
  { label: 'read:Concordia-domains', repo: 'Concordia', extra: `Concordia は最大 (src 2871 ファイル、spec 40k 行) のハブ。このリーダーは「ドメイン棚卸し」担当: spec/README.md, spec/ux/product.md, spec/architecture/{ddd,nodejs-service-principles}.md, spec/domains/*.domain.json (全部列挙して各ドメインの価値 ID・状態所有者を要約), spec/plan/refactor-3axis-architecture.md, spec/plan/cc-stability-analysis.md, spec/interface/service-schema.md, spec/setup/config-reference.md (設定キーの多さ), src/ 直下のディレクトリ一覧 (約 90 個) を責務グループに分類。Discord/Slack/Web UI/MCP/hook の入口。SQLite 単一 DB と worker (cost/chat/control/workflow) 構成。integrations は別リーダーが担当するので、こちらは概念・責務・設定負荷・肥大化の兆候 (spec/plan/* の計画群) に集中。` },
  { label: 'read:Concordia-integrations', repo: 'Concordia', extra: `Concordia は最大のハブ。このリーダーは「他ツールとの統合」担当: src/{anatomia,excubitor,pr,taskflow,deploy,projects,memoria,genius?,consultation,domain-review,release,service-status,service-versions,checkouts,federation,subsidiary,delegation,harness,mcp,skills} を中心に、Anatomia / Augur / Revisor / Genius / Praeforma / Breviarium / Conflux / Actio / Excubitor / Memoria / Elegantia をどう呼ぶか・呼ばれるかを grep で全列挙 (fetch 先 URL, env 名, CLI 実行, Discord チャンネル)。spec/feature/{delegation,subsidiary-delegation,task-workflow,task-workflow-v3,revisor-local-pr-submission,domain-review-discord,federation-link,usage-budgets,personal-ai-budget,daily-goal-run,tech-consultation}.md と spec/feature/*actio*, *anatomia*, *augur*, *genius*, *conflux*, *cdgd* を読む。Concordia が「project / repository / team / sprint / PR / session / task」をどう定義・保持しているか (src/projects, src/pr, src/taskflow, src/db)。ハブとしての負荷集中点・単一障害点・同期呼び出し。` },
  { label: 'read:Conflux', repo: 'Conflux', extra: `重点: README, spec/architecture/{overview,code-map,service-operation,cc-integration}.md, spec/ux/product.md, spec/feature/*, spec/domains/, spec/tasks/*, src/adapters/{config,http}/*。Cc との統合で「Cc 側未定義」の経路一覧。Breviarium と同じ構造 (host-origin-guard / describeHealth / loadConfig / contracts with @ludiars/log-weaver / node --test / Node 24 / 依存ゼロ) に見えるので、Breviarium とのコード類似度を具体ファイルで確認する。` },
  { label: 'read:Genius', repo: 'Genius', extra: `重点: README, CLAUDE.md, spec/feature/{clone-db,operations,active-questioning,judgment-outcome,card-feedback}.md, spec/setup/{clients,ingest,config-reference,anatomia-program-layers}.md, spec/interface/api.md, spec/data/schema.md, src/ 構成, hooks/, prompts/。Ingest ソース (memory / session logs / chat / review / Memoria / Claude・Codex JSONL) と Concordia Timer Delegation 経由の毎朝 ingest、Discord への「結果は?」配信、Actio との関係 (17 件の言及)、Anatomia program layers との関係。Ollama 依存と warmup、センシティブ象限。` },
  { label: 'read:Praeforma', repo: 'Praeforma', extra: `重点: README, CLAUDE.md, BACKLOG.md, spec/feature/{praeforma,ux-core-design,screen-flow,deferred-planning,studio,data-design,local-mode,concept-sheet}.md, spec/plan/mvp-plan.md, spec/schema/*, spec/test/acceptance-script.md, server/src 構成 (routes, lib, auth), web/, Packages/jp.ludiars.praeforma (Unity UPM), skills/, docs/manual/*。Anatomia API 直接取得 (PRAEFORMA_ANATOMIA_URL), Actio (74 件の言及) / Tela / Genius / Cernere との関係, Breviarium が読む acceptance run, Confluence 取得。Hono+Drizzle+Postgres だが catalog では SQLite ローカルモード、という二重構成の負荷。` },
  { label: 'read:Revisor', repo: 'Revisor', extra: `重点: README, spec/architecture.md, spec/feature/{review-gate,review-plan,local-pr-pipeline,pr-lifecycle,pr-lifecycle-notice,merge-risk,security-scan,remote-publication,checkout-publication,local-workspace,daemonless-cli,crash-recovery,review-concurrency,service-version,managed-git-runtime,runtime-execution}.md, spec/plan/discord-webhook-notice-design.md, src/*.mjs 構成。Augur (review plan CLI), Anatomia (PR 解析・domain review・verify), Codex (security scan / opposite-provider review), Concordia (報告チャンネル・local PR submission), Genius (15 件の言及), Discord/Slack webhook, GitHub App push。「審査 1 本あたり」のコスト (worktree 作成, Anatomia 解析, Codex 実行) と直列マージ、60 秒 sweep、daemon (serve) と CLI の二重性。` },
]

const SELECT = (args && Array.isArray(args.readers)) ? args.readers : null
const jobs = SELECT ? readerJobs.filter(j => SELECT.includes(j.label)) : readerJobs
const runScouts = !(args && args.scouts === false)
const repoMaps = await parallel(jobs.map(j => () =>
  agent(`${ECOSYSTEM}
あなたの担当: ${ROOT}/${j.repo} (${j.label})。
${j.extra}
${READ_GUIDE}
担当リポの構造化マップを StructuredOutput で返す。size は "find ${ROOT}/${j.repo} -path '*/node_modules' -prune -o -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' -o -name '*.cs' \\) -print | grep -v dist | wc -l" と spec/**/*.md の wc -l で測る。`,
    { label: j.label, phase: 'Read repos', schema: REPO_SCHEMA })))

log(`repo maps: ${repoMaps.filter(Boolean).length}/${jobs.length} returned`)

phase('Cross-cutting scouts')

const DUP_SCHEMA = {
  type: 'object',
  properties: {
    concerns: { type: 'array', items: { type: 'object', properties: {
      concern: { type: 'string' },
      occurrences: { type: 'array', items: { type: 'object', properties: {
        repo: { type: 'string' }, file: { type: 'string' }, symbol: { type: 'string' }, notes: { type: 'string' } }, required: ['repo', 'file'] } },
      similarity: { type: 'string', description: 'ほぼ同一 / 同じ責務で実装差あり / 名前だけ同じ' },
      sharedPackageCandidate: { type: 'string', description: '共通化するなら何という形 (npm パッケージ / Excubitor 側機能 / テンプレート) が自然か' },
      caveat: { type: 'string', description: '共通化すべきでない理由があれば (個人データ方針、依存ゼロ方針、セキュリティ境界 等)' },
    }, required: ['concern', 'occurrences', 'similarity'] } },
    vendoredLibs: { type: 'array', description: 'lib/ に同梱された @ludiars/* パッケージの配布状況', items: { type: 'object', properties: {
      name: { type: 'string' }, repos: { type: 'array', items: { type: 'string' } }, howReferenced: { type: 'string' }, versionDrift: { type: 'string' } }, required: ['name', 'repos'] } },
    contractRuntimeVariants: { type: 'array', description: 'augur.contracts.json の importFrom / runtimeFile の方式ごとの一覧', items: { type: 'object', properties: {
      repo: { type: 'string' }, importFrom: { type: 'string' }, runtimeFile: { type: 'string' }, notes: { type: 'string' } }, required: ['repo', 'importFrom'] } },
    toolchainMatrix: { type: 'array', description: 'リポごとの Node 版 / 起動方式 (dist か src 直) / テストランナ / lint / ビルド必須か / tsconfig 数', items: { type: 'object', properties: {
      repo: { type: 'string' }, nodeEngine: { type: 'string' }, start: { type: 'string' }, needsBuild: { type: 'string' }, testRunner: { type: 'string' }, lint: { type: 'string' }, deps: { type: 'string' } }, required: ['repo'] } },
    summary: { type: 'string' },
  },
  required: ['concerns', 'vendoredLibs', 'contractRuntimeVariants', 'toolchainMatrix', 'summary'],
}

const REGISTRY_SCHEMA = {
  type: 'object',
  properties: {
    registries: { type: 'array', description: '「プロジェクト / リポジトリ / サービス」を登録・管理する台帳が各ツールにいくつあるか', items: { type: 'object', properties: {
      repo: { type: 'string' }, name: { type: 'string' }, identityKey: { type: 'string', description: 'code / project_code / repo slug / 絶対パス / UUID など' },
      storedIn: { type: 'string' }, registeredHow: { type: 'string', description: '手動 UI / CLI / catalog 走査 / 他サービス同期' }, fields: { type: 'string' }, evidence: { type: 'string' },
      syncedWith: { type: 'string', description: '他の台帳との同期があれば (例: Actio が Cc projects を取り込む)' } }, required: ['repo', 'name', 'identityKey', 'storedIn', 'evidence'] } },
    identityMismatches: { type: 'array', description: '同じプロジェクトを指す識別子が台帳ごとに違う例 (project_code: Br vs breviarium, code 大小, リポ slug vs パス)', items: { type: 'object', properties: {
      description: { type: 'string' }, evidence: { type: 'string' } }, required: ['description', 'evidence'] } },
    serviceDiscovery: { type: 'array', description: '他サービスの所在をどう知るか (env *_URL 注入 / *_CLI 絶対パス / ハードコード / 設定ファイル)', items: { type: 'object', properties: {
      repo: { type: 'string' }, target: { type: 'string' }, envVar: { type: 'string' }, mechanism: { type: 'string' }, fallback: { type: 'string' }, evidence: { type: 'string' } }, required: ['repo', 'target', 'mechanism', 'evidence'] } },
    notificationSenders: { type: 'array', description: 'Discord / Slack / webhook へ投稿する実装の一覧', items: { type: 'object', properties: {
      repo: { type: 'string' }, channelKind: { type: 'string' }, file: { type: 'string' }, purpose: { type: 'string' }, viaConcordia: { type: 'string' } }, required: ['repo', 'channelKind', 'file'] } },
    publicEntrances: { type: 'array', description: 'Cloudflare Tunnel / Access で公開している入口と、その認証実装の所在', items: { type: 'object', properties: {
      repo: { type: 'string' }, publicUrl: { type: 'string' }, authImpl: { type: 'string' }, evidence: { type: 'string' } }, required: ['repo', 'evidence'] } },
    edges: { type: 'array', description: '確認できた呼び出し辺 (from → to)', items: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' }, mechanism: { type: 'string' }, purpose: { type: 'string' }, evidence: { type: 'string' } }, required: ['from', 'to', 'mechanism', 'evidence'] } },
    summary: { type: 'string' },
  },
  required: ['registries', 'identityMismatches', 'serviceDiscovery', 'notificationSenders', 'publicEntrances', 'edges', 'summary'],
}

const scouts = !runScouts ? [null, null] : await parallel([
  () => agent(`${ECOSYSTEM}
あなたの担当: 横断スカウト「横断的関心の再実装」。9 リポの src/ (Praeforma は server/src, Revisor は src/*.mjs) を grep して、同じ横断的関心が複数リポで別々に実装されている箇所を具体ファイルで列挙する。
調べる関心 (最低限): host/origin guard (LUDIARS_ALLOWED_HOSTS, admitWebRequest), Cloudflare Access JWT 検証 (cloudflareaccess, AUD, EXCUBITOR_SERVICE_CONFIG_JSON), loopback 強制 (127.0.0.1 / ::1 チェック), 設定ローダ (loadConfig, env 読み取りと検証), health エンドポイント (describeHealth, /health, /healthz, /api/health), 他サービス URL 解決 (CONCORDIA_URL, ANATOMIA_URL, REVISOR_URL, AUGUR_URL, ACTIO_URL, PRAEFORMA_URL, GENIUS_URL), Discord/Slack 投稿と mention 無害化 (neutralize, allowedMentions, @everyone), webhook POST with timeout, contract runtime (contract-runtime.*, observe), JSONL ログ / Vestigium / log-weaver, retry/timeout ユーティリティ (AbortSignal.timeout, fetch with timeout), SQLite 初期化・migration ランナー, HTML エスケープ / サーバサイド HTML 描画 (esc, render*Page), Excubitor catalog / topology の読み取り, GitHub (gh CLI / App) 呼び出し, git 操作ラッパ (execFile git), Codex / claude CLI 起動ラッパ (one-shot?), 版ファイル / service version。
加えて lib/ 同梱パッケージ (Actio: terpsichore, vestigium / Anatomia: aiformat, lapilli, vestigium / Concordia: aop-metrics, blackbox, lapilli, memory, vestigium / Praeforma: lapilli / Revisor: lapilli) の配布方法と版ずれ (各 lib/*/package.json の version を比較) を調べる。
augur.contracts.json の importFrom / runtimeFile の方式差 (../contract-runtime.js / ./contracts/runtime.js / templates/contract-runtime / @ludiars/log-weaver / ./ontime-runtime.js / ./contract-runtime.mjs) を一覧化し、Augur/templates/contract-runtime/ との関係を確認する。
toolchainMatrix は各 package.json の engines / scripts / devDependencies と tsconfig*.json の数から埋める。
grep の例: grep -rn --include='*.ts' --include='*.mjs' -l 'cloudflareaccess' ${ROOT}/*/src ${ROOT}/Praeforma/server/src。類似度の判定は実際に両方のファイルを読んで行う。`,
    { label: 'scout:duplicated-infra', phase: 'Cross-cutting scouts', schema: DUP_SCHEMA }),
  () => agent(`${ECOSYSTEM}
あなたの担当: 横断スカウト「台帳・サービス発見・通知・公開入口・呼び出し辺」。9 リポを grep して以下を具体ファイルで列挙する。
1. registries: 「プロジェクト / リポジトリ / サービス / チーム」を登録・保持する台帳。候補: Concordia (src/projects, repositories, departments, subsidiary, federation), Breviarium (src/registry, data/ 台帳), Anatomia (projects.json, --home registry, src/project), Augur (per-repository test registry, augur.config.json), Revisor (repository registration, workspace state, version file), Praeforma (projects テーブル, anatomia_repo), Conflux (project-workspaces), Actio (pm projects, cc project binding modules/task/team/cc-project-*, groups), Genius (projects?), Excubitor catalog (project_code)。各台帳の identityKey と、他台帳との同期の有無。
2. identityMismatches: excubitor.catalog.yaml の project_code (actio / anatomia / augur / Br / concordia / Cf / Gn / praeforma / revisor) のような表記ゆれ、リポ slug (LUDIARS/Actio) と code (actio) と絶対パス (${'${ARS_ROOT}'}/Actio) の対応がどこで決まるか。
3. serviceDiscovery: 各リポが他サービスをどう見つけるか (grep: _URL, _CLI, EXCUBITOR, topology, provides)。明示 env → Excubitor 注入 → 既定 の優先順位と、既定が無く「未接続」になる経路。
4. notificationSenders: Discord / Slack / webhook / Concordia 報告チャンネルへ投稿するコード (grep: discord, slack, webhook, allowedMentions, hooks.slack.com, discord.com/api)。Concordia 経由か直接か。
5. publicEntrances: Cloudflare Tunnel / Access (grep: cloudflareaccess, PUBLIC_URL, ai-run-do.com, ALLOWED_ORIGINS, Tailscale) と、それぞれの JWT 検証実装の所在。
6. edges: 確認できた from→to の呼び出し辺を全部 (HTTP fetch 先 / execFile で呼ぶ CLI / MCP / hook / Discord)。Concordia は src/{anatomia,pr,taskflow,deploy,excubitor,memoria,consultation,domain-review,release,service-status,service-versions} を優先。`,
    { label: 'scout:registries-and-edges', phase: 'Cross-cutting scouts', schema: REGISTRY_SCHEMA }),
])

return {
  repoMaps: repoMaps.filter(Boolean),
  duplicatedInfra: scouts[0],
  registriesAndEdges: scouts[1],
}
