import { describe, expect, it } from "vitest";
import {
  pickSpawnProjectIdentificationInject,
  SPAWN_WITH_CWD_INJECT,
  SPAWN_WITHOUT_CWD_INJECT,
} from "./spawn-project-identification.js";

describe("pickSpawnProjectIdentificationInject", () => {
  it("returns the root-skill instruction for a cwd-provided Cc spawn", () => {
    expect(pickSpawnProjectIdentificationInject({
      concordia_spawn_id: "spawn-a",
      concordia_spawn_cwd_mode: "provided",
    })).toBe(SPAWN_WITH_CWD_INJECT);
  });

  it("returns the project-question instruction for a cwd-omitted Cc spawn", () => {
    expect(pickSpawnProjectIdentificationInject({
      concordia_spawn_id: "spawn-b",
      concordia_spawn_cwd_mode: "omitted",
    })).toBe(SPAWN_WITHOUT_CWD_INJECT);
  });

  it("does not inject for manually launched or malformed sessions", () => {
    expect(pickSpawnProjectIdentificationInject({
      concordia_spawn_cwd_mode: "provided",
    })).toBeNull();
    expect(pickSpawnProjectIdentificationInject({
      concordia_spawn_id: "spawn-c",
      concordia_spawn_cwd_mode: "unknown",
    })).toBeNull();
  });
});
