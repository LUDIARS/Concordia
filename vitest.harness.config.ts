import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

// Dedicated isolated fixture suite; never starts the application or external services.
export default mergeConfig(base, defineConfig({ test: { include: ["tests/harness-reliability/**/*.test.ts"] } }));
