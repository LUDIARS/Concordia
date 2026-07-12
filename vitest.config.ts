import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      CONCORDIA_DISABLE_CLAUDE: "1",
    },
    exclude: [
      ...configDefaults.exclude,
      "lib/aop-metrics/src/**/*.test.ts",
      "lib/blackbox/src/**/*.test.ts",
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
