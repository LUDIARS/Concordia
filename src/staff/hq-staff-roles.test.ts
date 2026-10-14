/**
 * SPEC-FED-STAFF-ROLES: 拠点は本社の名簿の役職と自分の名簿を比べ、高いほうで権限を判定する。
 */
import type Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, makeTestDir } from "../../tests/helpers/db.js";
import { readFederationConfigCache, writeFederationConfigCache } from "../federation/config-cache.js";
import { StaffRepo } from "../db/staff-repo.js";
import { createFederationConfigSnapshot, readHqStaffRoles } from "../federation/config-snapshot.js";
import { parseFederationFrame } from "../federation/protocol.js";
import { authorizeStaffCapability } from "./capability-authorization.js";
import { HQ_STAFF_ROLES_KEY, higherRole, hqRoleOf, parseHqStaffRoles, serializeHqStaffRoles } from "./hq-staff-roles.js";

const NECO = "905235114026467350";

describe("hq staff roles", () => {
  it("parses only well-formed manager / executive rows", () => {
    expect(parseHqStaffRoles(JSON.stringify([
      { platform: "discord", user_id: NECO, role: "executive" },
      { platform: "discord", user_id: "1", role: "staff" },
      { platform: "irc", user_id: "2", role: "manager" },
      { platform: "slack", user_id: "", role: "manager" },
    ]))).toEqual([{ platform: "discord", user_id: NECO, role: "executive" }]);
    expect(parseHqStaffRoles("broken")).toEqual([]);
    expect(parseHqStaffRoles(null)).toEqual([]);
    expect(parseHqStaffRoles("{}")).toEqual([]);
  });

  it("picks the higher role and finds a user's HQ role", () => {
    expect(higherRole("staff", "executive")).toBe("executive");
    expect(higherRole("executive", "manager")).toBe("executive");
    expect(higherRole(null, "manager")).toBe("manager");
    expect(higherRole("manager", null)).toBe("manager");
    expect(higherRole(null, null)).toBeNull();
    const roles = [{ platform: "discord" as const, user_id: NECO, role: "manager" as const }];
    expect(hqRoleOf(roles, "discord", NECO)).toBe("manager");
    expect(hqRoleOf(roles, "slack", NECO)).toBeNull();
  });
});

describe("site authorization with HQ roles", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeTestDb(); });

  const storeHqRoles = (value: string) =>
    db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)").run(HQ_STAFF_ROLES_KEY, value);

  it("lets an HQ manager end sessions at a site where the local roster says staff", () => {
    const staff = new StaffRepo(db);
    staff.touch({ platform: "discord", platformUserId: NECO, displayName: "neco" });
    expect(authorizeStaffCapability(staff, "discord", NECO, "session_end").allowed).toBe(false);
    storeHqRoles(serializeHqStaffRoles([{ platform: "discord", user_id: NECO, role: "manager" }]));
    expect(staff.roleOf("discord", NECO)).toBe("manager");
    expect(authorizeStaffCapability(staff, "discord", NECO, "session_end").allowed).toBe(true);
    expect(authorizeStaffCapability(staff, "discord", NECO, "kill_switch").allowed).toBe(false);
  });

  it("never lowers a role raised in the site's own roster, and ignores a broken stored value", () => {
    const staff = new StaffRepo(db);
    staff.touch({ platform: "discord", platformUserId: NECO });
    staff.update("discord", NECO, { role: "executive" });
    storeHqRoles(serializeHqStaffRoles([{ platform: "discord", user_id: NECO, role: "manager" }]));
    expect(staff.roleOf("discord", NECO)).toBe("executive");
    storeHqRoles("not json");
    expect(staff.roleOf("discord", "123456789012345678")).toBeNull();
  });
});

describe("offline cache keeps the HQ roles", () => {
  it("round-trips staff_roles and drops malformed rows", async () => {
    const path = join(makeTestDir("concordia-staff-roles-cache-"), ".federation-config-cache.json");
    await writeFederationConfigCache(path, {
      discord: {}, templates: [], staff_roles: [{ platform: "discord", user_id: NECO, role: "manager" }],
    });
    expect(readFederationConfigCache(path)?.staff_roles).toEqual([{ platform: "discord", user_id: NECO, role: "manager" }]);
    writeFileSync(path, JSON.stringify({ discord: {}, templates: [], staff_roles: [{ platform: "discord", user_id: NECO, role: "god" }] }));
    expect(readFederationConfigCache(path)?.staff_roles).toEqual([]);
    writeFileSync(path, JSON.stringify({ discord: {}, templates: [] }));
    expect(readFederationConfigCache(path)).not.toHaveProperty("staff_roles");
  });
});

describe("HQ snapshot carries the roster's roles", () => {
  it("sends only IDs and roles of managers and above, and the frame stays valid", () => {
    const db = makeTestDb();
    const staff = new StaffRepo(db);
    staff.touch({ platform: "discord", platformUserId: NECO, displayName: "neco" });
    staff.update("discord", NECO, { role: "executive", note: "秘密のメモ" });
    staff.touch({ platform: "discord", platformUserId: "111111111111111111", displayName: "hira" });
    expect(readHqStaffRoles(db)).toEqual([{ platform: "discord", user_id: NECO, role: "executive" }]);
    const snapshot = createFederationConfigSnapshot(db, []);
    expect(JSON.stringify(snapshot)).not.toContain("秘密のメモ");
    expect(JSON.stringify(snapshot)).not.toContain("neco");
    const parsed = parseFederationFrame(JSON.stringify({ v: 1, type: "config-snapshot", snapshot }));
    expect(parsed.ok).toBe(true);
  });
});
