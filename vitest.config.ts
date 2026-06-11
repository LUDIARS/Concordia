import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      CONCORDIA_DISABLE_CLAUDE: "1",
    },
    setupFiles: ["./tests/helpers/setup.ts"],
    poolOptions: {
      forks: {
        // fork worker の同時数を抑える。 ファイル毎 isolate × 並行セッションの
        // メモリ圧で worker が heap OOM した実績があるため (2026-06-11)。
        maxForks: 4,
      },
    },
  },
});
