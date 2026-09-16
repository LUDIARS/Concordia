#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";

const repo = resolve(process.cwd());
const augur = "E:/Document/Ars/Augur/bin/augur.mjs";
const domainDefs = readdirSync(resolve(repo, "spec/domains"))
  .filter((file) => file.endsWith(".domain.json"))
  .map((file) => JSON.parse(readFileSync(resolve(repo, "spec/domains", file), "utf8")));
const files = listFiles(resolve(repo, "tests")).filter((file) => /\.(test|spec)\.tsx?$/.test(file));
for (const file of files) {
  const rel = relative(repo, file).split(sep).join("/");
  const business = domainDefs.filter((domain) => (domain.membership ?? []).some((member) => {
    if (!member.pathPattern) return false;
    try { return new RegExp(member.pathPattern).test(rel); } catch { return false; }
  })).map((domain) => domain.name);
  if (business.length === 0) continue;
  const program = `shared:${dirname(rel).replaceAll("\\\\", "/")}`;
  execFileSync(process.execPath, [augur, "tests", "register", "--repo", repo, "--file", rel, "--name", rel, "--runner", "vitest", "--program", program, ...business.flatMap((name) => ["--business", name])], { stdio: "inherit" });
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? listFiles(resolve(dir, entry.name)) : [resolve(dir, entry.name)]);
}
