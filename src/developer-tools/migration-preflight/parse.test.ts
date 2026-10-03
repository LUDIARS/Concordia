import { describe, expect, it } from "vitest";
import { parseMigrations } from "./parse.js";

const schema = (items: string) => `export const MIGRATIONS: readonly Migration[] = [${items}];`;
const item = `{version: 41, name: "baseline", source: JSON.stringify(data), up(db) { db.exec("SQL"); }}`;
describe("static migration parser", () => {
  it("extracts without importing or executing any schema expressions", () => {
    const result = parseMigrations(`throw new Error("must not execute"); ${schema(item)}`);
    expect(result[0]).toMatchObject({ version: 41, name: "baseline" });
  });
  it("ignores comments and formatting but retains changes to up", () => {
    const original = parseMigrations(schema(item))[0];
    expect(parseMigrations(schema(item.replace("version:", "/* note */ version:  ")))[0]).toEqual(original);
    expect(parseMigrations(schema(item.replaceAll(",", ",\n")))[0]).toEqual(original);
    expect(parseMigrations(schema(item.replace('"SQL"', '"OTHER SQL"')))[0].definition).not.toBe(original.definition);
  });
  it.each([
    "", "export const MIGRATIONS = [", "export const MIGRATIONS = getMigrations();",
    schema("...other"), schema(item.replace("41", "nextVersion")), schema(item.replace("41", "-1")),
    schema(item.replace("41", "1.5")), schema(item.replace("41", "9007199254740992")),
    schema(`${item}, ${item}`), schema(item.replace('name: "baseline"', "name: dynamicName")),
    schema(item.replace("version: 41", "version: 41, version: 42")),
    schema(item.replace("version: 41", "...base, version: 41")),
    schema(item.replace("version: 41", "[version]: 41")),
    `${schema(item)} ${schema(item)}`,
  ])("rejects unsupported or invalid schema: %s", source => {
    expect(() => parseMigrations(source)).toThrow();
  });
  it("accepts a statically empty array", () => {
    expect(parseMigrations(schema(""))).toEqual([]);
  });
});
