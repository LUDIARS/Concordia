import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      CONCORDIA_DISABLE_CLAUDE: "1",
    },
  },
});
