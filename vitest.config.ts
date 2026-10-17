import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      CONCORDIA_DISABLE_CLAUDE: "1",
      NODE_ENV: "test",
    },
    exclude: [
      ...configDefaults.exclude,
      "lib/lapilli/**",
      "lib/aop-metrics/src/**/*.test.ts",
      "lib/blackbox/src/**/*.test.ts",
      // node:test で書かれ、.augur/tests.jsonl で `node --test` (runner=command) として登録されているもの。
      // vitest で読むと shebang 付きモジュールの import で SyntaxError になり、全体実行を落とす。
      "tools/internal-agent-hook.test.mjs",
      "tools/concordia-hook-migration.test.mjs",
      "tools/consultation-harness.test.mjs",
      "tools/concordia-hook-runtime.test.mjs",
      "tools/concordia-hook-mcp.test.mjs",
    ],
    setupFiles: ["./tests/helpers/setup.ts"],
    // 子プロセス fork の worker pool は使わない。 fork worker はクラッシュ時に孤児
    // プロセスとして残り、 better_sqlite3.node 等のファイルロックをリークしうる
    // (2026-07-02 指示: リーク回避のため fork pool 廃止)。 worker_threads は親プロセスと
    // 運命を共にするため、 プロセスリークが構造的に起きない。
    // better-sqlite3 を使う app-level tests が複数 worker の teardown で access violation
    // になることがあるため、thread pool は維持しつつ 1 worker に固定する。
    pool: "threads",
    // better-sqlite3 を使う app-level tests が worker isolate teardown で access violation
    // になることがあるため、thread pool は維持しつつ isolate だけ共有する。
    isolate: false,
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
});
