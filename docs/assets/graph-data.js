/* Concordia ドメイン関連グラフのデータ (src/ の import 解析より) */
window.GRAPH_DATA = {
  categories: {
    core:          { label: "Core / infra",          color: "#60a5fa" },
    lifecycle:     { label: "Session lifecycle",      color: "#34d399" },
    coordination:  { label: "Coordination",           color: "#a78bfa" },
    identity:      { label: "Identity / config",      color: "#fbbf24" },
    platform:      { label: "Integrations / platform", color: "#f472b6" },
    observability: { label: "Observability",          color: "#2dd4bf" },
  },
  nodes: [
    // core / infra
    { id: "db",       label: "db",       category: "core", role: "SQLite 層。DB を開き migration を適用し、エンティティ別 repository を公開する全体の永続化基盤。", files: ["index.ts", "schema.ts", "sessions-repo.ts"] },
    { id: "events",   label: "events",   category: "core", role: "プロセス内 pub/sub イベントバス。ConcordiaEvent union を定義。dispatcher/sweeper/api が emit し、SSE/WS/chat/rules が購読。", files: ["events.ts"] },
    { id: "shared",   label: "shared",   category: "core", role: "横断ユーティリティ。runtime config / logger / quiet-hours / secret-box / 共有型 / admin auth。", files: ["config.ts", "logger.ts", "types.ts"] },
    { id: "app",      label: "app",      category: "core", role: "Hono app ファクトリ。api/* ルータを 1 つの HTTP app に配線する。", files: ["app.ts"] },
    { id: "server",   label: "server",   category: "core", role: "バックエンド entrypoint = composition root。config 読込・DB 起動・全 repo/service/scheduler/bot を生成し HTTP server を起動。", files: ["server.ts"] },
    { id: "auth",     label: "auth",     category: "core", role: "Claude Code OAuth の rate-usage を内部 usage API から取得。token は永続化しない leaf モジュール。", files: ["anthropic-oauth-usage.ts"] },

    // session lifecycle
    { id: "api",        label: "api",        category: "lifecycle", role: "HTTP ルートハンドラ (Hono ルータ群)。sessions / chat / reports / PRs / cost / personas / delegation / spawn / stat / stream など外部サーフェス。", files: ["sessions.ts", "chat.ts", "stream.ts"] },
    { id: "sweeper",    label: "sweeper",    category: "lifecycle", role: "バックグラウンドループ。停滞 active を lost→abandoned に遷移、provider recovery を試行、古い event を auto-purge。", files: ["sweeper.ts"] },
    { id: "report",     label: "report",     category: "lifecycle", role: "セッション終了レポート生成 (構造化 bullets + claude/API/template ナラティブ)。", files: ["generator.ts"] },
    { id: "processes",  label: "processes",  category: "lifecycle", role: "ProcessManager。repo の dev-process.md から dev プロセスを spawn/監視し、ログを永続化。", files: ["manager.ts", "runner.ts", "dev-process-md.ts"] },
    { id: "providers",  label: "providers",  category: "lifecycle", role: "provider 名 → AgentProvider 実装 (claude-code / codex-cli / gemini-cli) のレジストリ。recovery に使用。", files: ["index.ts", "types.ts"] },
    { id: "stat",       label: "stat",       category: "lifecycle", role: "stat-collect タスクを enqueue する scheduler (interval poll + idle trigger)。セッション活動のスナップショット。", files: ["scheduler.ts", "repo-change-watcher.ts"] },

    // coordination
    { id: "dispatcher", label: "dispatcher", category: "coordination", role: "Concordia 側の静的アルゴリズム。topic-shift / work-count cadence / quiet-hours / session-departed / daily-report で chitchat/review/通知タスクの発火を決定。", files: ["dispatcher.ts"] },
    { id: "delegation", label: "delegation", category: "coordination", role: "委託サービス。テンプレートを render し sub-session を spawn、run を記録。", files: ["service.ts", "persona-context.ts"] },
    { id: "work",       label: "work",       category: "coordination", role: "ローカル repo clone を走査し current branch / worktree / 所有 session を取得 (Work ページ用)。", files: ["repo-scan.ts"] },
    { id: "pr",         label: "pr",         category: "coordination", role: "PR キュー。session stat から open PR を取り込み正規化、状態 (merged/CI/review) を照合し pr.changed を emit。", files: ["ingest.ts", "reconcile.ts", "queue.ts"] },
    { id: "triggers",   label: "triggers",   category: "coordination", role: "topic-shift 検出と会話シード選択。dispatcher が使用。", files: ["topic-change.ts", "seeds.ts"] },
    { id: "rules",      label: "rules",      category: "coordination", role: "ルールエンジン。tick / event 駆動のルールが claude CLI を invoke (single mutex)。prompt builder + action handler + proposer。claude-runner は personas/daily/report からも再利用。", files: ["engine.ts", "claude-runner.ts", "handler.ts"] },

    // identity / config
    { id: "personas",      label: "personas",      category: "identity", role: "活動シグナルからセッション persona を合成 (claude CLI + heuristic fallback)。feedback / signals。", files: ["generate.ts", "signals.ts", "feedback.ts"] },
    { id: "role",          label: "role",          category: "identity", role: "tool/file-type 使用からセッションの role をルールベースで推論。", files: ["predict.ts"] },
    { id: "skills",        label: "skills",        category: "identity", role: "skill ファイルスナップショットの poison/growth スコアリング (analyzer)。", files: ["analyzer.ts"] },
    { id: "model-catalog", label: "model-catalog", category: "identity", role: "起動時に選択可能なモデルカタログ (provider+model_id) を seed。", files: ["seed.ts"] },

    // integrations / platform
    { id: "discord",  label: "discord",  category: "platform", role: "Discord ChatPlatform 一式。bot / ingress / egress / channel layout / reactions / cost・error・PR channel / commands。", files: ["bot.ts", "egress.ts", "ingress.ts"] },
    { id: "slack",    label: "slack",    category: "platform", role: "Slack ChatPlatform (Socket Mode, thread-per-session)。bot / render / slash / cost canvas / delegation modal。", files: ["bot.ts", "render.ts", "slash.ts"] },
    { id: "platform", label: "platform", category: "platform", role: "Discord/Slack のライフサイクルを抽象する ChatPlatform contract。reaction-workflow + working-indicator の共有ヘルパ。", files: ["chat-platform.ts", "reaction-workflow.ts"] },
    { id: "control",  label: "control",  category: "platform", role: "セッション制御プレーン。Lictor ラップ端末の spawn / reaper / session-end / error-fix / provider preset / key injection。", files: ["spawner.ts", "reaper.ts", "lictor-launcher.ts"] },
    { id: "mcp",      label: "mcp",      category: "platform", role: "MCP stdio サーバ (core / delegation / vestigium)。横断状態を tool としてエージェントに公開。", files: ["core-server.ts", "delegation-server.ts", "vestigium-server.ts"] },

    // observability
    { id: "cost",    label: "cost",    category: "observability", role: "token 使用量トラッキング、日次予算強制、cost feed/report 集計。Claude OAuth usage を取得。", files: ["usage-tracker.ts", "cost-report.ts"] },
    { id: "metrics", label: "metrics", category: "observability", role: "host/process パフォーマンススナップショット (CPU / RSS / lictor PID subtree によるセッション別メモリ)。", files: ["collector.ts", "process-tree.ts"] },
    { id: "daily",   label: "daily",   category: "observability", role: "日次レポートの aggregator / generator / scheduler (1 日単位のナラティブ要約)。", files: ["generator.ts", "aggregator.ts"] },
    { id: "admin",   label: "admin",   category: "observability", role: "runtime 切替の admin スイッチ (chat_muted / rules_enabled / proposer interval / workspace_root / github_org) を schema_meta に永続化。", files: ["state.ts"] },
  ],
  edges: [
    ["app","api"],["app","db"],["app","control"],["app","shared"],["app","delegation"],["app","admin"],["app","processes"],["app","platform"],["app","metrics"],["app","dispatcher"],["app","discord"],["app","daily"],["app","cost"],
    ["server","db"],["server","control"],["server","slack"],["server","shared"],["server","pr"],["server","discord"],["server","stat"],["server","rules"],["server","platform"],["server","personas"],["server","metrics"],["server","delegation"],["server","cost"],["server","sweeper"],["server","processes"],["server","model-catalog"],["server","events"],["server","dispatcher"],["server","daily"],["server","app"],["server","api"],["server","admin"],
    ["dispatcher","db"],["dispatcher","shared"],["dispatcher","triggers"],["dispatcher","role"],
    ["sweeper","db"],["sweeper","shared"],["sweeper","providers"],["sweeper","dispatcher"],["sweeper","events"],
    ["api","db"],["api","shared"],["api","control"],["api","events"],["api","cost"],["api","processes"],["api","pr"],["api","personas"],["api","dispatcher"],["api","daily"],["api","work"],["api","slack"],["api","skills"],["api","rules"],["api","report"],["api","metrics"],["api","delegation"],
    ["control","shared"],["control","db"],["control","events"],["control","admin"],["control","work"],["control","report"],["control","personas"],["control","dispatcher"],
    ["delegation","db"],["delegation","control"],["delegation","shared"],["delegation","personas"],
    ["pr","db"],["pr","shared"],["pr","events"],
    ["work","shared"],["work","db"],
    ["rules","db"],["rules","shared"],["rules","events"],
    ["triggers","shared"],
    ["personas","db"],["personas","shared"],["personas","rules"],["personas","role"],["personas","events"],
    ["role","shared"],
    ["model-catalog","db"],
    ["daily","db"],["daily","shared"],["daily","rules"],
    ["cost","shared"],["cost","db"],["cost","auth"],
    ["metrics","db"],["metrics","shared"],["metrics","control"],
    ["report","shared"],["report","rules"],
    ["processes","shared"],["processes","events"],["processes","db"],
    ["providers","shared"],
    ["stat","db"],["stat","shared"],["stat","events"],
    ["discord","db"],["discord","shared"],["discord","platform"],["discord","events"],["discord","control"],["discord","pr"],["discord","rules"],["discord","mcp"],["discord","cost"],["discord","auth"],
    ["slack","db"],["slack","shared"],["slack","platform"],["slack","events"],["slack","discord"],["slack","rules"],["slack","cost"],["slack","control"],
    ["platform","rules"],["platform","events"],["platform","control"],
  ].map(([from, to]) => ({ from, to })),
};
