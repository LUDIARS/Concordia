import { expect, it } from "vitest";
import { makeTestDb } from "../helpers/db.js";
import { HarnessAuditRepo } from "../../src/db/harness-audit-repo.js";
import { HarnessRulesRepo } from "../../src/db/harness-rules-repo.js";
import { harnessSessionRouter } from "../../src/api/harness-session.js";

it("keeps implementation editable but denies submission with unavailable mandatory evidence", async () => {
  const db = makeTestDb();
  const app = harnessSessionRouter({ audit: new HarnessAuditRepo(db), rules: new HarnessRulesRepo(db),
    projectPolicy: async () => ({ ddd: false, contract: false, testsRequired: true }),
  });
  const request = (action: object) => app.request("/gate", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: "fixture", action: { cwd: "Z:/nonexistent-cc-fixture", branch: "feat/fixture", ...action } }) });
  const edit = await (await request({ tool: "Edit", filePath: "src/run.ts" })).json() as any;
  expect(edit.blocked).not.toBe(true);
  const submit = await (await request({ tool: "Bash", command: "git commit -m fixture" })).json() as any;
  expect(submit.decision).toBe("deny");
  expect(JSON.stringify(submit)).toContain("code-acceptance");
});
