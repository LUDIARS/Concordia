import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVulnerabilities, lockedPackages } from "./vulnerabilities.js";
describe("locked dependency extraction", () => {
  it("deduplicates nested dependencies and preserves scoped names", () => {
    expect(lockedPackages({ lockfileVersion: 3, packages: {
      "": { version: "3.0.0" }, "node_modules/@scope/name": { version: "1.2.3" },
      "node_modules/parent/node_modules/@scope/name": { version: "1.2.3" },
      "node_modules/local": { link: true },
    } })).toEqual([{ name: "@scope/name", version: "1.2.3" }]);
  });
  it("does not call unsupported or unresolved data safe", () => {
    expect(() => lockedPackages({ lockfileVersion: 1 })).toThrow("unsupported_lockfile");
    expect(() => lockedPackages({ lockfileVersion: 3, packages: { "node_modules/a": { version: "git:secret" } } })).toThrow("unresolved_dependency");
  });
  it("keeps local dependencies unverified and follows OSV continuation tokens", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cc-vulnerability-test-"));
    try {
      await writeFile(join(cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {
        "node_modules/public-package": { version: "1.2.3" },
        "node_modules/local-package": { version: "1.0.0", resolved: "file:../local" },
      } }), "utf8");
      const request = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ results: [{ next_page_token: "next" }] }))
        .mockResolvedValueOnce(Response.json({ results: [{ vulns: [{ id: "GHSA-example" }] }] }));
      expect(await checkVulnerabilities(cwd, request)).toMatchObject({
        checked: 1, coverage: "partial", passed: null, registry_dependencies_passed: false,
        excluded: [{ package: "local-package", reason: "local_or_non_registry_dependency" }],
        findings: [{ package: "public-package", ids: ["GHSA-example"] }],
      });
      const body = JSON.parse(String(request.mock.calls[1]?.[1]?.body));
      expect(body.queries).toEqual([{ package: { name: "public-package", ecosystem: "npm" }, version: "1.2.3", page_token: "next" }]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
