import { describe, expect, it } from "vitest";
import { parsePackageJsonDeclarations, readDependencyDeclarations } from "./dependency-declarations.js";

describe("dependency declarations", () => {
  it("package.json の dependencies / devDependencies だけを名前と版指定で返す", () => {
    const text = JSON.stringify({
      name: "x", scripts: { build: "tsc" },
      dependencies: { hono: "^4.6.0", "@scope/pkg": "1.2.3" },
      devDependencies: { vitest: "^2.1.0" },
    });
    expect(parsePackageJsonDeclarations("package.json", text)).toEqual({
      manifest: "package.json",
      dependencies: { hono: "^4.6.0", "@scope/pkg": "1.2.3" },
      dev_dependencies: { vitest: "^2.1.0" },
    });
  });

  it("ローカルパスや URL の指定は種別だけを残し、不正な名前は落とす", () => {
    const text = JSON.stringify({ dependencies: { local: "file:../secret-dir", remote: "git+ssh://host/repo.git", "bad name": "1.0.0" } });
    expect(parsePackageJsonDeclarations("package.json", text)?.dependencies).toEqual({ local: "file:", remote: "git+ssh:" });
  });

  it("JSON でなければ null", () => {
    expect(parsePackageJsonDeclarations("package.json", "{not json")).toBeNull();
  });

  it("main の package.json 系だけを git show で読み、読めないものは飛ばす", async () => {
    const seen: string[] = [];
    const git = async (_repo: string, args: readonly string[]) => {
      seen.splice(seen.length, 0, args.join(" "));
      return args[1] === "main:package.json" ? JSON.stringify({ dependencies: { zod: "^3.0.0" } }) : null;
    };
    const result = await readDependencyDeclarations(git, "/repo", ["package.json", "web/package.json", "Cargo.toml"]);
    expect(seen.sort()).toEqual(["show main:package.json", "show main:web/package.json"]);
    expect(result).toEqual([{ manifest: "package.json", dependencies: { zod: "^3.0.0" }, dev_dependencies: {} }]);
  });
});
