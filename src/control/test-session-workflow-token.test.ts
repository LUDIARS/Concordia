import { describe, expect, it } from "vitest";
import type { RevisorConfigRepo } from "../db/revisor-config-repo.js";
import { setRevisorConfig } from "../pr/revisor-config.js";
import { SecretBox } from "../shared/secret-box.js";
import {
  resolveTestSessionWorkflowEnv,
  TEST_SESSION_REVISOR_TOKEN_ENV,
} from "./test-session-workflow-token.js";

function configRepo(): RevisorConfigRepo {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value); },
    delete: (key) => { values.delete(key); },
  };
}

describe("resolveTestSessionWorkflowEnv", () => {
  it("does not delegate the secret to ordinary sessions", () => {
    expect(resolveTestSessionWorkflowEnv(null, undefined, undefined, {})).toEqual({ ok: true, env: {} });
  });

  it("delegates the configured token only for a Test Forum session", () => {
    const config = configRepo();
    const secretBox = new SecretBox(Buffer.alloc(32, 7));
    setRevisorConfig(config, secretBox, { workflowToken: "workflow-secret" });

    expect(resolveTestSessionWorkflowEnv(42, config, secretBox, {})).toEqual({
      ok: true,
      env: { [TEST_SESSION_REVISOR_TOKEN_ENV]: "workflow-secret" },
    });
  });

  it("fails before spawn when the token cannot be delegated", () => {
    const config = configRepo();
    const secretBox = new SecretBox(Buffer.alloc(32, 7));
    expect(resolveTestSessionWorkflowEnv(42, config, secretBox, {})).toEqual({
      ok: false,
      error: "Revisor workflow token is not configured",
    });
  });
});
