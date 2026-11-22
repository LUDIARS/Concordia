/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    /**
     * module-runtime-composition-only
     * A module's runtime.ts is the only thing that runs when that module is ON. If any
     * non-composition file imports it, turning the module off leaves a dangling call —
     * that is exactly the "off drags others down" failure the manifest is meant to prevent.
     * federation/runtime.ts is the precedent; bootstrap/core.ts walks the manifest and
     * calls start() (spec/feature/module-manifest.md §3, §5).
     */
    {
      name: "module-runtime-composition-only",
      severity: "error",
      comment:
        "Only composition roots may import a module runtime (spec/feature/module-manifest.md §3)",
      from: {
        path: "^src/",
        pathNot: [
          // Composition roots — wiring points, allowed to start module runtimes
          "^src/server\\.ts$",
          "^src/app\\.ts$",
          "^src/bootstrap/",
          "^src/[a-z-]+-worker\\.ts$",
          // ルートの登録で orbis / cloud-work の runtime を作って router に渡す組み立て点
          "^src/api/register-core\\.ts$",
          "\\.test\\.ts$",
        ],
      },
      to: {
        path: "^src/[a-z-]+/runtime\\.ts$",
      },
    },

    /**
     * manifest-stays-declarative
     * The module ledger describes how modules are wired; it must not become a second
     * wiring point. If it imports module implementations, reading the ledger starts
     * pulling in the very modules it claims may be off.
     */
    {
      name: "manifest-stays-declarative",
      severity: "error",
      comment:
        "The module manifest must stay declarative — no imports of module implementations",
      from: {
        path: "^src/modules/manifest\\.ts$",
      },
      to: {
        path: "^src/",
        pathNot: ["^src/modules/", "^src/shared/"],
      },
    },

    /**
     * core-no-chat
     * Core / non-platform modules must not import chat-platform (discord/ slack/) modules.
     * Composition roots (server.ts, app.ts) are wiring points and excluded.
     */
    {
      name: "core-no-chat",
      severity: "error",
      comment:
        "Core modules must not directly import chat-platform (discord/slack) modules",
      from: {
        path: "^src/",
        pathNot: [
          // Composition roots — wiring points, allowed to import anything
          "^src/server\\.ts$",
          "^src/app\\.ts$",
          "^src/bootstrap/core\\.ts$",
          "^src/chat-worker\\.ts$",
          "^src/api/register-chat\\.ts$",
          // Chat modules themselves
          "^src/discord/",
          "^src/slack/",
          // Test files
          "\\.test\\.ts$",
          // V5: api/delegation.ts → discord/delegation-template-cache
          "^src/api/delegation\\.ts$",
          // V5: api/slack-admin.ts → slack/config
          "^src/api/slack-admin\\.ts$",
          // 試遊動画を Discord / Slack の同じ投稿に添付するため、添付の上限 (DISCORD_ATTACH_MAX_BYTES) を共有する
          "^src/playtest-review/playtest-review-video\\.ts$",
        ],
      },
      to: {
        path: "^src/(discord|slack)/",
      },
    },

    /**
     * core-no-cost-write
     * Core engine modules (rules/, control/, harness/, report/, subsidiary/) must not import
     * from the cost layer — except the designated files that legitimately access cost data.
     */
    {
      name: "core-no-cost-write",
      severity: "error",
      comment:
        "Core engine modules must not import from cost layer (only designated cost accessors are allowed)",
      from: {
        path: "^src/(rules|control|harness|report|subsidiary)/",
        pathNot: [
          "\\.test\\.ts$",
          // Allowed exceptions — files with legitimate cost layer access:
          "^src/rules/claude-runner\\.ts$",     // records cost via one-shot-recorder
          "^src/rules/patrol-codex-runner\\.ts$", // records cost via one-shot-recorder (Codex 版の巡回)
          "^src/control/periodic-progress-request\\.ts$", // reads budget-suspension to skip suspended sessions
          "^src/report/generator\\.ts$",        // reads session-cost for report generation
          "^src/subsidiary/budget\\.ts$",       // reads log-usage / usage-tracker for budgeting
        ],
      },
      to: {
        path: "^src/cost/",
      },
    },

    /**
     * chat-no-core-runner
     * Chat-platform modules (discord/, slack/) must not import the core runner (rules/claude-runner)
     * or control layer modules — they should receive results via callbacks or events.
     */
    {
      name: "chat-no-core-runner",
      severity: "error",
      comment:
        "Chat-platform modules must not import core runner or control modules",
      from: {
        path: "^src/(discord|slack)/",
        pathNot: [
          "\\.test\\.ts$",
          // V: discord/reply-spawn.ts → rules/claude-runner.ts (reply-triggered spawning)
          "^src/discord/reply-spawn\\.ts$",
          // V: discord/commands/goal.ts → control/goal
          "^src/discord/commands/goal\\.ts$",
          // V: discord/commands/spawn.ts → control/token
          "^src/discord/commands/spawn\\.ts$",
          // V: discord/session-status-card.ts → control/goal, control/requester
          "^src/discord/session-status-card\\.ts$",
          // V: slack の依頼者の解決 → control/requester (Requester 型と parseRequesterSource のみ)
          "^src/slack/bot\\.ts$",
          "^src/slack/member-map\\.ts$",
          "^src/slack/session-starter-invite\\.ts$",
        ],
      },
      to: {
        path: "^src/(rules/claude-runner|control)/",
      },
    },

    /**
     * cost-no-chat
     * The cost layer must not import chat-platform modules (discord/, slack/).
     */
    {
      name: "cost-no-chat",
      severity: "error",
      comment: "Cost layer must not import chat-platform (discord/slack) modules",
      from: {
        path: "^src/cost/",
        pathNot: ["\\.test\\.ts$"],
      },
      to: {
        path: "^src/(discord|slack)/",
      },
    },

    /**
     * cost-no-subsidiary
     * The cost layer must not import subsidiary modules (budget tracking lives in subsidiary/).
     */
    {
      name: "cost-no-subsidiary",
      severity: "error",
      comment: "Cost layer must not import subsidiary modules",
      from: {
        path: "^src/cost/",
        pathNot: [
          "\\.test\\.ts$",
        ],
      },
      to: {
        path: "^src/subsidiary/",
      },
    },

    /**
     * slack-no-discord
     * The Slack adapter must not import Discord adapter modules.
     * They are parallel adapters for the same abstract platform layer.
     */
    {
      name: "slack-no-discord",
      severity: "error",
      comment: "Slack adapter must not import Discord adapter modules",
      from: {
        path: "^src/slack/",
        pathNot: [
          "\\.test\\.ts$",
        ],
      },
      to: {
        path: "^src/discord/",
      },
    },

    /**
     * platform-no-adapters
     * Transport-neutral chat policy must not depend on either concrete adapter.
     */
    {
      name: "platform-no-adapters",
      severity: "error",
      comment: "Platform policy must not import Discord or Slack adapters",
      from: {
        path: "^src/platform/",
        pathNot: ["\\.test\\.ts$"],
      },
      to: {
        path: "^src/(discord|slack)/",
      },
    },

    /**
     * no-circular
     * Circular dependencies are forbidden — they cause module-init ordering issues
     * and obscure the dependency structure.
     * 輪のどこかが `import type` (実行時に消える) なら初期化順の問題は起きないので数えない。
     * Augur の契約ファイル (*.contract.ts) が実装の型を読み、実装が契約を import する形もこれに当たる。
     */
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular runtime dependencies are forbidden (cycles closed by a type-only import are allowed)",
      from: {
        pathNot: [
          "\\.test\\.ts$",
        ],
      },
      to: {
        circular: true,
        dependencyTypesNot: ["type-only"],
        viaOnly: { dependencyTypesNot: ["type-only"] },
      },
    },
  ],

  options: {
    doNotFollow: {
      // Do not follow into node_modules or type-only declaration files
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".js", ".ts", ".mts", ".cts"],
    },
    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/[^/]+",
      },
      archi: {
        collapsePattern:
          "^(node_modules|src/(discord|slack|cost|control|rules|subsidiary|harness|report|api))/[^/]+",
      },
    },
  },
};
