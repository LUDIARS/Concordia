import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { declaredServicePort, readRevisorCatalogPort } from "./revisor-catalog-port.js";

const CATALOG = [
  "services:",
  "  - code: other",
  "    port: 5000",
  "  - code: revisor",
  "    port: 4321",
].join("\n");

function catalogWithRevisorPort(port: string): string {
  return ["services:", "  - code: revisor", `    port: ${port}`].join("\n");
}

describe("declaredServicePort", () => {
  it("returns the declared port of the named service", () => {
    expect(declaredServicePort(CATALOG, "revisor")).toBe(4321);
    expect(declaredServicePort(CATALOG, "other")).toBe(5000);
  });

  it("returns null when the service or its port is missing", () => {
    expect(declaredServicePort(CATALOG, "absent")).toBeNull();
    expect(declaredServicePort(["services:", "  - code: revisor"].join("\n"), "revisor")).toBeNull();
    expect(declaredServicePort("name: no services", "revisor")).toBeNull();
    expect(declaredServicePort("", "revisor")).toBeNull();
  });

  it("rejects invalid ports and unparsable YAML", () => {
    expect(declaredServicePort(catalogWithRevisorPort("0"), "revisor")).toBeNull();
    expect(declaredServicePort(catalogWithRevisorPort("70000"), "revisor")).toBeNull();
    expect(declaredServicePort(catalogWithRevisorPort(JSON.stringify("4240")), "revisor")).toBeNull();
    expect(declaredServicePort("services: [unclosed", "revisor")).toBeNull();
  });
});

describe("readRevisorCatalogPort", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("reads <root>/Revisor/excubitor.catalog.yaml", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-revisor-catalog-"));
    dirs.push(root);
    await mkdir(join(root, "Revisor"));
    await writeFile(join(root, "Revisor", "excubitor.catalog.yaml"), CATALOG, "utf8");
    expect(await readRevisorCatalogPort(root)).toBe(4321);
  });

  it("returns null when the catalog file is absent or the root is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-revisor-catalog-"));
    dirs.push(root);
    expect(await readRevisorCatalogPort(root)).toBeNull();
    expect(await readRevisorCatalogPort("")).toBeNull();
  });
});
