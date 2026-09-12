import { describe, expect, it } from "vitest";
import { matchProjectRow } from "./service-code-match.js";

const rows = [
  { code: "Cc", project: "Concordia", repo_origin: "https://github.com/LUDIARS/Concordia.git" },
  { code: "Rv", project: "Revisor", repo_origin: "https://github.com/LUDIARS/Revisor" },
  { code: "Mm", project: "Memoria", repo_origin: null },
];

describe("matchProjectRow", () => {
  it("prefers the exact project code", () => {
    expect(matchProjectRow(rows, "Rv")?.code).toBe("Rv");
  });

  it("maps an Excubitor service code to the project name case-insensitively", () => {
    expect(matchProjectRow(rows, "revisor")?.code).toBe("Rv");
    expect(matchProjectRow(rows, "CONCORDIA")?.code).toBe("Cc");
  });

  it("falls back to the repository name of repo_origin", () => {
    expect(matchProjectRow([{ code: "X", project: "Something Else", repo_origin: "git@github.com:LUDIARS/Revisor.git" }], "revisor")?.code).toBe("X");
  });

  it("strips a component suffix such as memoria-server", () => {
    expect(matchProjectRow(rows, "memoria-server")?.code).toBe("Mm");
  });

  it("returns null for unknown or blank codes", () => {
    expect(matchProjectRow(rows, "genius")).toBeNull();
    expect(matchProjectRow(rows, "  ")).toBeNull();
  });
});
