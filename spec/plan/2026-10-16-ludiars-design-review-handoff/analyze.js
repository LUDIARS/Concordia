export const meta = {
  name: 'ludiars-analyze',
  description: 'Cross-cutting analysis of the 9 LUDIARS tools along selected dimensions',
  phases: [{ title: 'Analyze', detail: 'one analyst per dimension, reading digests + repos' }],
}

const WF = '/tmp/claude-0/-home-user/32afae0b-127d-59be-8436-fc8b058671df/scratchpad/wf'
const ROOT = '/home/user'

const COMMON = `
背景: ${ROOT}/ 配下に LUDIARS の AI 開発支援ツール 9 リポ (Actio, Anatomia=An, Augur, Breviarium=Br, Concordia=Cc, Conflux=Cf, Genius=Gn, Praeforma=Pf, Revisor=Rv) がある。
リポ外の関連サービス (対象外だが参照は可): Excubitor (サービス管理・catalog・Vault・topology env 注入), Cernere (認証), Elegantia, Voluptas, Memoria, Vestigium (ログ), Schedula, Aedilis, Nuntius, Tela, Lictor, Castra (hooks 配信), Terpsichore, Lapilli (@ludiars/one-shot)。
レビューの目的: 9 ツール間のドメイン重複・無駄、管理の手間、アクセスのボトルネックを見つけ、より高次元・高速に最適化する改善提案を作る。提案は各リポに spec/plan/ 文書としてコミットされ、小さく安全な項目は別エージェント (Opus) が実装する。
入力: ${WF}/digest-*.md (次元別ダイジェスト、リポ別リーダー 10 体と横断スカウト 2 体の出力を抽出したもの)、${WF}/map-*.json (リーダーの全文)、${WF}/scout-*.json、${WF}/notes-fable.md。ダイジェストの主張は根拠付きだが、所見にする前に必ず該当ファイルを自分で開いて確認する (node_modules / dist は読まない)。
既存の自己分析 (Concordia spec/plan/refactor-3axis-architecture.md, cc-stability-analysis.md, 2026-10-11-cc-rv-data-growth-audit.md, spec/architecture/nodejs-service-principles.md) と重複する所見は「既知 (参照)」として短く扱い、新規の横断所見に重心を置く。
出力は日本語。根拠は「リポ/ファイルパス:行番号」。推測は「推測」と明記。最終テキストは人間向けメッセージではなく生データ。
所見の品質基準:
- 1 所見 = 1 つの具体的な問題。「〜が重複している」なら、どのリポのどのファイルが同じ責務をどう別実装しているかまで書く。
- 提案は「何をどこへ寄せるか / 誰が正本か / 移行の順序 / 受入条件」を含む。選択肢があれば 2 案まで並べ、推奨を 1 つ選ぶ。
- 「implementNow」は、単一リポで閉じ・振る舞いを変えない・typecheck/テストで検証できる・30 分以内の変更だけ true にする (例: 設定/ドキュメントの乖離修正、死んだ依存/コードの除去、ハードコード既定値の env 化、重複キーの修正、timeout 未設定の明示化、health ルート追加)。共通パッケージ抽出や他リポとの同時配備が要るものは false。
- severity: high = 日常の開発速度・可用性・正しさに今効いている / medium = 蓄積コストや将来の事故要因 / low = 整頓。
- 所見は最大 14 件。薄い所見より深い所見。`

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    dimension: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string', description: '例: D1-03' },
      title: { type: 'string' },
      claim: { type: 'string', description: '何が問題か (3〜6 文)。数字・名前を具体的に' },
      evidence: { type: 'array', items: { type: 'object', properties: {
        repo: { type: 'string' }, file: { type: 'string' }, lines: { type: 'string' }, note: { type: 'string' } }, required: ['repo', 'file'] } },
      affectedRepos: { type: 'array', items: { type: 'string' } },
      impactKind: { type: 'string', description: '重複 | 管理負荷 | ボトルネック | 所有権不整合 | ドキュメント乖離 | 可用性' },
      severity: { type: 'string', description: 'high | medium | low' },
      knownAlready: { type: 'string', description: '既存の自己分析文書に同趣旨があれば参照、なければ空' },
      proposal: { type: 'object', properties: {
        summary: { type: 'string' },
        owner: { type: 'string', description: '正本/責任をどのリポ (またはリポ外サービス) に置くか' },
        steps: { type: 'array', items: { type: 'string' } },
        alternatives: { type: 'array', items: { type: 'string' } },
        effort: { type: 'string', description: 'S (〜半日) | M (〜1 週) | L (それ以上)' },
        risk: { type: 'string' },
        acceptance: { type: 'string', description: '完了をどう確認するか' } }, required: ['summary', 'owner', 'steps', 'effort', 'acceptance'] },
      implementNow: { type: 'object', properties: {
        feasible: { type: 'boolean' }, repo: { type: 'string' }, changeSummary: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
        verification: { type: 'string', description: 'このリポで実行するコマンド (typecheck / test)' }, whyNot: { type: 'string' } }, required: ['feasible'] },
      confidence: { type: 'string', description: 'high | medium | low' },
    }, required: ['id', 'title', 'claim', 'evidence', 'affectedRepos', 'impactKind', 'severity', 'proposal', 'implementNow', 'confidence'] } },
    crossCuttingObservation: { type: 'string', description: 'この次元から見た全体像 (5〜10 文)。提案文書の総論に使う' },
  },
  required: ['dimension', 'findings', 'crossCuttingObservation'],
}

const DIMENSIONS = {
  d1: { label: 'D1 ドメイン重複', digest: 'digest-d1-domain-overlap.md', brief: `
担当: 概念レベルの重複と所有権の不整合。問い: 同じ業務概念 (project / repository / team / sprint / task / PR / review / domain / spec / acceptance / contract / evidence / cost / session / notification / registry) を複数のツールがそれぞれ所有・保持・再定義していないか。正本が宣言されていても実態 (キャッシュ・コピー・独自 ID) が二重になっていないか。
特に確認: (1) 「プロジェクト台帳」が何個あるか (Cc project_codes / Br registry / An projects.json / Augur repositories.json / Rv repository registration / Pf projects / Cf workspaces / Actio project_refs / Excubitor catalog project_code) と識別子の対応表。(2) task/作業単位の台帳 (Actio tasks / Cc delegation run / spec/tasks/*.md / Memoria)。(3) コード↔仕様 (An SpecClause・Link・spec/domains vs Pf specs/domains vs Augur contracts vs cc.acceptance.json)。(4) PR/レビュー/品質 (Rv vs An review/pr-review vs Cc pr/ vs Augur review-plan)。(5) cost (An cost-feed/one-shots vs Cc cost)。(6) 通知配送 (Cc 経由 vs 各自 Discord/Slack webhook)。(7) Br と Cf の骨格の同一性 (同じ adapters/http/*, contracts, 依存ゼロ)。(8) Actio と Cc の team/sprint/chat 責務分割。
提案は「正本を 1 つに決め、他はキャッシュ/射影にする」「台帳を Excubitor catalog か Cc project_codes に統合する」など、統合先と移行順序を具体化する。` },
  d2: { label: 'D2 コード重複', digest: 'digest-d2-code-duplication.md', brief: `
担当: 横断的関心 (host/origin guard, Cloudflare Access JWT, loopback 判定, 設定ローダ, health, 他サービス URL 解決, Discord/Slack 投稿と mention 無害化, webhook timeout, contract runtime, JSONL ログ, retry/timeout, git/子プロセス wrapper, LLM backend 切替, SQLite 初期化, HTML escape/描画) が各リポで別実装されている実態を、ファイルを開いて類似度を確定する。
出力したい表: 関心 × リポ (ファイル) × 類似度 (ほぼ同一 / 同責務別実装 / 名前だけ) × 共通化の受け皿案 (例: @ludiars/service-kit のような小パッケージ、Excubitor 側機能 (CF Access 検証を Ex の入口で済ませる等)、Augur テンプレート配布の改善、Lapilli への追加)。
各関心について「共通化すべきでない理由」(依存ゼロ方針、個人データ方針、セキュリティ境界、Node 版差) も検討し、提案の粒度を決める。Breviarium と Conflux の host-origin-guard / describeHealth / loadConfig / esc / render は diff を取って実際の一致率を測る (diff コマンド可)。
contract runtime の配布 (Augur templates → 各リポ生成コピー、importFrom 6 通り、@ludiars/log-weaver 未依存) は必ず 1 所見にする。` },
  d3: { label: 'D3 管理負荷', digest: 'digest-d3-management-burden.md', brief: `
担当: 「管理の手間」= 9 リポを維持・配備・更新するのに人 (と AI) が払っている反復コスト。問い: ツールチェーンのばらつき (Node 版 5 通り、vitest/node --test、dist 起動/src 直起動、lint 有無、tsconfig の数)、共有ライブラリ配布 (submodule 3 系統の版ずれ、コミット済みコピー、生成コピー、GitHub Packages)、ビルド鎖 (prebuild で submodule を tsc)、設定/secret 経路の層数、catalog/env 名の規約 (X_URL / X_CLI / project_code の表記ゆれ)、spec/ フォルダ規約の乖離 (CLAUDE.md と実態、AIFormat harness の配信)、テスト↔要求の台帳 3 系統 (cc.acceptance.json / augur.contracts.json / .augur/tests.jsonl)、review/ 成果物の重複、ドキュメント腐敗 (README/CLAUDE.md が旧構成を説明)、問題記録 (problem_logs) の分散。
各所見に「年間/週間の反復回数の見積り (推測可)」と「標準化の受け皿 (AIFormat / Castra 配信 / Excubitor / 共通テンプレート)」を書く。Node 版は実際の package.json / .nvmrc / Dockerfile / CI yml を開いて確定する。` },
  d4: { label: 'D4 アクセスのボトルネック', digest: 'digest-d4-bottlenecks.md', brief: `
担当: 速度とアクセス性。問い: どこで待たされるか・何が直列か・何が毎回コールドか・どのハブに負荷が集中するか・どの経路が多ホップか。候補: Actio→Cc の全面ポーリング (10 分/30 秒/1 分) と Cc からの push 不在、Actio chat tick の単一 lease 直列、An の CLI cold analyze と warm サーバ 3h idle・autostart false、An の UserPromptSubmit で毎回 plan LLM ~10 秒、An→Augur の HTTP 内同期 execFile (10 分)、Br の直列 refresh (14 ソース × 全プロジェクト、An CLI 120 秒)、Rv の審査 1 本あたり (worktree + An 解析 + Codex) と直列マージ・60 秒 sweep、Rv ダッシュボード 3 秒ポーリング 21MB (既知)、Cc の単一 SQLite・単一プロセス (既知: 3 軸分離計画)、Gn の Ollama warmup と /healthz、各サービスの health probe 1 秒上限と ::1 問題、公開入口の 3 ホップ (cloudflared → web → api) と CF Access で全員 1 ユーザーに畳む問題、Pf 連携の 50 件直列ページング、テストスイート時間 (Actio 2〜3.5 分直列、An 200 秒)、初回セットアップ (submodule + native build + build)。
各所見に「現在の待ち時間/頻度の実測または仕様値」「改善後の見込み」「変更の受け皿 (push/webhook 化、常駐化、キャッシュ、並列化、プロトコル統一)」を書く。既知の 3 つの Cc 文書と重複する部分は参照に留める。` },
  d5: { label: 'D5 統合トポロジと所有権', digest: 'digest-d5-topology-ownership.md', brief: `
担当: 9 ツール + 周辺サービスの呼び出しグラフを確定し、構造的な問題を所見にする。手順: (1) ダイジェストの edges / integrationsOut / integrationsIn から from→to の辺を全部集め、機構 (HTTP / CLI execFile / MCP / hook / Discord / env 注入 / file) と向き・同期性で分類した一覧表 (mermaid でも可) を crossCuttingObservation に含める。(2) ハブ度 (入次数+出次数) を数え、Cc と An への集中を定量化。(3) 「未接続」「Cc 側未定義」「計画のみ」の辺 (Cf の 4 経路、Br の未接続ソース、An の task sink、Actio の Memoria/Jev/Genius、Pf の Actio 読み返し) を一覧化し、放置コスト (架空の成功を作らない設計で止まっている機能) を評価。(4) 双方向往復 (An↔Cc の cost / Pf↔Actio の仕様↔実装状況 / Actio↔Cc の team・sprint・chat) を抽出し、所有権の分割線が妥当か判断。(5) サービス発見 (Excubitor provides / 明示 env / ハードコード既定 / CLI 絶対パス) の不統一を所見に。(6) 「Cc を経由すべきもの」と「直接結ぶべきもの」の判断基準を提案する。
提案は、ハブ集中を下げる具体案 (イベント配送の一本化、Cc の API 分割、An の cost 受信を Cc へ移管、Br/Cf の Cc 依存の整理) を含める。` },
  d6: { label: 'D6 即効改善候補 (実装対象)', digest: 'digest-d6-quick-wins.md', brief: `
担当: 「今日 Opus が単一リポで安全に実装できる」改善を最大 14 件、根拠付きで列挙する。すべて implementNow.feasible = true にし、files と verification (実行コマンド) を具体化する。候補例 (必ず自分でファイルを開いて現状を確認し、既に直っていれば除外): Actio spec/domains/web-frontend.domain.json の specRefs 重複キー; Actio .claude/settings.json の pre-push が別リポ Schedula の ci-check.sh を指す; Actio src/index.ts の文字化けログ; Actio frontend Dashboard の CERNERE_URL localhost:8080 ハードコード; Actio deploy/excubitor.catalog.example.yaml の旧 /api/health; Actio package.json の未使用 @ludiars/schedula-module-* 依存 (import が本当に無いか grep); Anatomia src/providers/concordia-cost.ts の 127.0.0.1:11111 ハードコード (CONCORDIA_URL 必須化 or 明示警告); Anatomia に /health ルート追加 + catalog の health を http に; Anatomia CLAUDE.md の spec フォルダ記述を実態に合わせる; Anatomia src/cache/redis-store.ts の無言 no-op (規約違反) を警告ログ化; Augur / Genius / Revisor / Breviarium / Conflux の各 README・catalog・package.json の記述乖離; Breviarium/Conflux の engines >=24 と実行要件の整合; Concordia の spec/README.md が 6 分類と書く実態 (13 フォルダ); Praeforma の README ステータス記述; Revisor の問題; augur.contracts.json で importFrom=@ludiars/log-weaver なのに依存が無いリポ (Br/Cf/Pf) の整合; 各リポの .revisor-version uninitialized; Actio bash.exe.stackdump のコミット除去; 既に dist 起動なのに dev 依存が本番に要るリポ (Br: npm install --include=dev) の整理。
注意: 振る舞いを変える変更 (ポーリング間隔、timeout 値、認可) は候補にしない。ドキュメント修正は「現状のコードから機械的に確認できる事実への修正」だけ。各候補に「なぜ安全か」を whyNot の代わりに changeSummary の末尾に書く。` },
}

phase('Analyze')
const selected = (args && Array.isArray(args.dimensions)) ? args.dimensions : Object.keys(DIMENSIONS)
const results = await parallel(selected.map(key => () => {
  const d = DIMENSIONS[key]
  return agent(`${COMMON}
あなたの次元: ${d.label}
まず ${WF}/${d.digest} を全部読む (大きければ分割して読む)。必要に応じて ${WF}/map-*.json や ${ROOT}/<repo>/ の実ファイルを開いて確認する。
${d.brief}
StructuredOutput で返す。dimension は "${key}"。`, { label: `analyze:${key}`, phase: 'Analyze', schema: FINDINGS_SCHEMA })
}))
log(`analysts returned: ${results.filter(Boolean).length}/${selected.length}`)
return { dimensions: selected, results: results.filter(Boolean) }
