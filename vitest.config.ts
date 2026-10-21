import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Verify the pinned source even when a local dependency cache predates the gitlink.
  resolve: { alias: { "@ludiars/one-shot": fileURLToPath(new URL("./lib/lapilli/packages/one-shot/src/index.js", import.meta.url)) } },
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
    // singleThread + isolate: false では、jsdom の web/src テストは 1 つの jsdom 環境にまとめて流れ、
    // DOM が file 間で残る。ルート実行は globals を有効にしないので Testing Library の自動 cleanup も
    // 効かず、cleanup を呼ばない file の描画 (<table> 等) が次の file に見え、結果が実行順で変わる。
    // web だけ別 project にして、file ごとに再実行される setup で cleanup を登録する。
    // 隔離 (isolate: true) にはしない: worker が使い回されるため、外部化された Testing Library が
    // 最初の file の document を握ったままになり、かえって後続の file が壊れる。
    // ファイル指定の実行 (.augur/tests.jsonl の runner=vitest) はどちらの project にもそのまま効く。
    projects: [
      {
        extends: true,
        test: { name: "node", exclude: ["web/src/**"] },
      },
      {
        extends: true,
        test: {
          name: "web",
          include: ["web/src/**/*.test.{ts,tsx}"],
          setupFiles: ["./web/src/rootTestSetup.ts"],
        },
      },
    ],
  },
});
