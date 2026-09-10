import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCodeAcceptance } from "../../src/harness/reliability/code-acceptance.js";
import { ProjectCodesRepo } from "../../src/db/project-codes-repo.js";
import { makeTestDb } from "../helpers/db.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cc-acceptance-")); roots.push(root);
  const put = (name: string, value: unknown) => writeFileSync(join(root, name), typeof value === "string" ? value : JSON.stringify(value));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "tests")); mkdirSync(join(root, "contracts"));
  put("src/run.ts", "export const run = () => 1;");
  put("tests/run.test.ts", "it('returns expected result', () => expect(run()).toBe(1));");
  put("cc.acceptance.json", { version: 1, implementations: [{ source: "src/run.ts", tests: ["tests/run.test.ts"], contracts: ["C1"] }] });
  return { root, put };
}
describe("project acceptance requirements", () => {
  it("preserves independent opt-in flags across partial registry updates", () => {
    const repo = new ProjectCodesRepo(makeTestDb());
    repo.register({ code: "fixture", project: "fixture", repoPath: "fixture/path", repoOrigin: null, addedBy: "test" });
    expect(repo.findByCode("fixture")?.tests_required).toBe(0);
    repo.update("fixture", { testsRequired: true, ontimeTestsRequired: true });
    repo.update("fixture", { dddEnabled: true });
    expect(repo.findByCode("fixture")).toMatchObject({ tests_required: 1, ontime_tests_required: 1, ddd_enabled: 1 });
  });
  it("requires mapped test implementation but never claims execution passed", () => {
    const f = fixture();
    const policy = { ddd: false, contract: false, testsRequired: true };
    expect(checkCodeAcceptance(f.root, ["src/run.ts"], policy)).toMatchObject({ ok: true, execution: "not_checked" });
    f.put("tests/run.test.ts", "  ");
    expect(checkCodeAcceptance(f.root, ["src/run.ts"], policy).ok).toBe(false);
  });
  it("does not count a manifest without instrumentation as on-time implementation", () => {
    const f = fixture();
    f.put("contracts/run.ts", "export default {post: result => result === 1};");
    f.put("augur.contracts.json", { version: 1, contracts: [{ id: "C1", file: "src/run.ts", module: "contracts/run.ts", mode: "observe", sample: 1 }] });
    expect(checkCodeAcceptance(f.root, ["src/run.ts"], { ddd: false, contract: false, ontimeTestsRequired: true }).ok).toBe(false);
  });
  it("does not impose optional requirements on docs or unconfigured projects", () => {
    expect(checkCodeAcceptance("missing", ["spec/design.md"], { ddd: true, contract: false, testsRequired: true }).ok).toBe(true);
    expect(checkCodeAcceptance("missing", ["src/run.ts"]).ok).toBe(true);
  });
  it("rejects an escaped test reference", () => {
    const f = fixture();
    f.put("cc.acceptance.json", { version: 1, implementations: [{ source: "src/run.ts", tests: ["../tests/secret.test.ts"] }] });
    expect(checkCodeAcceptance(f.root, ["src/run.ts"], { ddd: false, contract: false, testsRequired: true }).ok).toBe(false);
  });
});
