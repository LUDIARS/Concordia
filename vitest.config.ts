import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      CONCORDIA_DISABLE_CLAUDE: "1",
    },
    setupFiles: ["./tests/helpers/setup.ts"],
    // 子プロセス fork の worker pool は使わない。 fork worker はクラッシュ時に孤児
    // プロセスとして残り、 better_sqlite3.node 等のファイルロックをリークしうる
    // (2026-07-02 指示: リーク回避のため fork pool 廃止)。 worker_threads は親プロセスと
    // 運命を共にするため、 プロセスリークが構造的に起きない。
    // 注: maxThreads を絞ると Windows でスイート途中の segfault が再現したため、
    // スレッド数は既定に任せる (2026-07-02 実測)。
    pool: "threads",
  },
});
