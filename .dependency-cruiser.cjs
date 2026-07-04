/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    /**
     * core-no-chat
     * Core / non-platform modules must not import chat-platform (discord/ slack/) modules.
     * Composition roots (server.ts, app.ts, discord-worker.ts) are wiring points and excluded.
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
          "^src/discord-worker\\.ts$",
          // Chat modules themselves
          "^src/discord/",
          "^src/slack/",
          // Test files
          "\\.test\\.ts$",
          // V5: api/delegation.ts → discord/delegation-template-cache
          "^src/api/delegation\\.ts$",
          // V5: api/slack-admin.ts → slack/config
          "^src/api/slack-admin\\.ts$",
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
          "^src/control/auto-compaction\\.ts$", // reads context-estimate for compaction
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
     * no-circular
     * Circular dependencies are forbidden — they cause module-init ordering issues
     * and obscure the dependency structure.
     */
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies are forbidden",
      from: {
        pathNot: [
          "\\.test\\.ts$",
          // V12 (discord-internal): discord/commands.ts is an index that imports all
          // sub-command handlers; each handler imports the DiscordCommandSpec type
          // back from discord/commands.ts → mutual import. Until the type is extracted
          // to a separate file, both sides of the cycle are excluded.
          "^src/discord/commands\\.ts$",
          "^src/discord/commands/",
          // V12 (discord-internal): question.ts and permission.ts are imported by
          // commands.ts and in turn import DiscordCommandSpec from commands.ts.
          "^src/discord/question\\.ts$",
          "^src/discord/permission\\.ts$",
        ],
      },
      to: {
        circular: true,
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
