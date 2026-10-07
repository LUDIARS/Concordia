import { describe, expect, it } from "vitest";
import { createSiteProjectsStore, SITE_PROJECTS_SETTINGS_KEY } from "./site-projects.js";

function memorySettings(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[SITE_PROJECTS_SETTINGS_KEY, initial]]);
  return { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value); }, values };
}

describe("site project assignments", () => {
  it("stores trimmed unique project codes per site and clears a site with an empty list", () => {
    const settings = memorySettings();
    const store = createSiteProjectsStore(settings);
    expect(store.set("melpot", [" Mp ", "Pa", "Mp", ""])).toEqual(["Mp", "Pa"]);
    store.set("gromac", ["Pa"]);
    expect(store.all()).toEqual({ melpot: ["Mp", "Pa"], gromac: ["Pa"] });
    expect(store.set("melpot", [])).toEqual([]);
    expect(store.get("melpot")).toEqual([]);
    expect(JSON.parse(settings.values.get(SITE_PROJECTS_SETTINGS_KEY)!)).toEqual({ gromac: ["Pa"] });
  });

  it("treats a broken stored value as no assignments (never guesses a site)", () => {
    expect(createSiteProjectsStore(memorySettings("not json")).all()).toEqual({});
    expect(createSiteProjectsStore(memorySettings("[1,2]")).all()).toEqual({});
    expect(createSiteProjectsStore(memorySettings(JSON.stringify({ a: ["Mp", 3], b: "x" }))).all()).toEqual({ a: ["Mp"] });
  });
});
