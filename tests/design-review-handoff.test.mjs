import { mkdtempSync, rmSync, readdirSync, readFileSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { loadDigestInput, REPOSITORIES } from "../tools/design-review/digest-input.mjs";
import { renderDigests } from "../tools/design-review/digest-renderer.mjs";
import { makeDigests } from "../tools/design-review/make-digests.mjs";

const fixtures = fileURLToPath(new URL("../spec/plan/2026-10-16-ludiars-design-review-handoff/", import.meta.url));
const temporary = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true }); });
function directory(withMaps = true) {
  const dir = mkdtempSync(join(tmpdir(), "cc-design-review-"));
  temporary.push(dir);
  if (withMaps) for (const file of readdirSync(fixtures).filter((f) => /^map-.*\.json$/.test(f))) {
    copyFileSync(join(fixtures, file), join(dir, file));
  }
  return dir;
}
const outputs = (dir) => readdirSync(dir).filter((f) => f.startsWith("digest-"));
function changeActio(dir, mutate) {
  const path = join(dir, "map-Actio.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutate(value);
  writeFileSync(path, JSON.stringify(value));
}

describe("review digests", () => {
  it("refuses the historical three-map handoff without an explicit partial choice", () => {
    const dir = directory();
    expect(() => makeDigests([dir])).toThrow(/Incomplete review.*Augur/);
    expect(outputs(dir)).toEqual([]);
  });
  it("retains supplied evidence and labels every partial digest", () => {
    const dir = directory();
    const input = loadDigestInput(dir, { allowPartial: true });
    const rendered = renderDigests(input);
    expect(Object.keys(rendered)).toHaveLength(6);
    expect(renderDigests(input)).toEqual(rendered);
    for (const text of Object.values(rendered)) {
      expect(text).toContain("PARTIAL / 未完了");
      expect(text).toContain("Maps (3/9): Actio, Anatomia, Breviarium");
      expect(text).toContain("scout-duplicated-infra.json");
      expect(text).toContain("scout-registries-and-edges.json");
      expect(text).not.toContain("[object Object]");
    }
    for (const { m } of input.maps) {
      for (const concept of m.coreConcepts) expect(rendered["digest-d1-domain-overlap.md"]).toContain(concept.definition);
      for (const point of m.painPoints) expect(rendered["digest-d6-quick-wins.md"]).toContain(point.evidence);
      for (const edge of m.integrationsOut) expect(rendered["digest-d5-topology-ownership.md"]).toContain(edge.evidence);
    }
    expect(makeDigests([dir, "--allow-partial"])).toHaveLength(6);
    for (const [name, text] of Object.entries(rendered)) expect(readFileSync(join(dir, name), "utf8")).toBe(text);
  });
  it("keeps the documented historical CLI entry point usable", () => {
    const dir = directory();
    const result = spawnSync(process.execPath, [join(fixtures, "make-digests.mjs"), dir, "--allow-partial"], {
      encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(outputs(dir)).toHaveLength(6);
  });
  it.each([
    ["identity mismatch", (m) => { m.repo = "Revisor"; }],
    ["missing field", (m) => { delete m.integrationsOut; }],
    ["malformed array", (m) => { m.painPoints = {}; }],
    ["malformed item", (m) => { m.coreConcepts = [null]; }],
    ["missing evidence", (m) => { m.painPoints = [{ kind: "perf", description: "example" }]; }],
  ])("rejects %s before touching existing output", (_name, mutate) => {
    const dir = directory();
    const old = join(dir, "digest-d1-domain-overlap.md");
    writeFileSync(old, "previous output");
    changeActio(dir, mutate);
    expect(() => makeDigests([dir, "--allow-partial"])).toThrow(/map-Actio.json/);
    expect(readFileSync(old, "utf8")).toBe("previous output");
    expect(outputs(dir)).toHaveLength(1);
  });
  it("rejects empty input and broken JSON", () => {
    const dir = directory(false);
    expect(() => makeDigests([dir, "--allow-partial"])).toThrow(/No map/);
    writeFileSync(join(dir, "map-Actio.json"), "{");
    expect(() => makeDigests([dir, "--allow-partial"])).toThrow(/map-Actio.json/);
    expect(outputs(dir)).toEqual([]);
  });
  it("rejects unknown repositories and invalid scout collections", () => {
    const dir = directory();
    writeFileSync(join(dir, "map-Other.json"), "{}");
    expect(() => makeDigests([dir, "--allow-partial"])).toThrow(/unknown repository/);
    rmSync(join(dir, "map-Other.json"));
    writeFileSync(join(dir, "scout-duplicated-infra.json"), JSON.stringify({ summary: "x", concerns: {} }));
    expect(() => makeDigests([dir, "--allow-partial"])).toThrow(/scout-duplicated-infra.json/);
    expect(outputs(dir)).toEqual([]);
  });
  it("distinguishes complete inputs from verified findings", () => {
    const dir = directory();
    const sample = JSON.parse(readFileSync(join(dir, "map-Actio.json"), "utf8"));
    // Synthetic maps exercise coverage only; these are not saved as review evidence.
    for (const repo of REPOSITORIES) writeFileSync(join(dir, `map-${repo}.json`), JSON.stringify({ ...sample, repo }));
    writeFileSync(join(dir, "scout-duplicated-infra.json"), JSON.stringify({ summary: "synthetic", concerns: [], vendoredLibs: [], contractRuntimeVariants: [], toolchainMatrix: [] }));
    writeFileSync(join(dir, "scout-registries-and-edges.json"), JSON.stringify({ summary: "synthetic", registries: [], identityMismatches: [], serviceDiscovery: [], notificationSenders: [], publicEntrances: [], edges: [] }));
    expect(loadDigestInput(dir).coverage).toContain("complete inputs (findings still require verification)");
  });
  it.each([[], ["--allow-partial"], ["dir", "--typo"], ["dir", "--allow-partial", "--allow-partial"]].map((argv) => [argv]))(
    "reports CLI misuse: %j", (argv) => { expect(() => makeDigests(argv)).toThrow(/Usage:/); },
  );
});
