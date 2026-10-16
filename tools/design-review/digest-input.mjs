import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const REPOSITORIES = Object.freeze([
  "Actio", "Anatomia", "Augur", "Breviarium", "Concordia", "Conflux", "Genius", "Praeforma", "Revisor",
]);

// Only fields consumed by the projection are required; historical extra fields survive.
const ARRAYS = {
  coreConcepts: ["name", "definition"], responsibilities: null,
  overlapsSuspected: ["withTool", "concept", "why"],
  crossCuttingReimplementations: ["concern", "file"],
  painPoints: ["kind", "description", "evidence"], accessBottlenecks: ["description", "evidence"],
  integrationsOut: ["target", "mechanism", "purpose", "evidence"],
  integrationsIn: ["source", "mechanism", "purpose", "evidence"],
  unconnectedOrPlanned: ["description", "evidence"], dataStores: ["kind", "holds"],
  interfaces: ["kind", "description"],
};
const SCOUTS = {
  "scout-duplicated-infra.json": {
    concerns: ["concern"], vendoredLibs: ["name"], contractRuntimeVariants: ["repo"], toolchainMatrix: ["repo"],
  },
  "scout-registries-and-edges.json": {
    registries: ["repo", "name", "identityKey", "storedIn"], identityMismatches: ["description", "evidence"],
    serviceDiscovery: ["repo", "target", "mechanism", "evidence"],
    notificationSenders: ["repo", "channelKind", "file"], publicEntrances: ["repo"],
    edges: ["from", "to", "mechanism", "evidence"],
  },
};
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const string = (v) => typeof v === "string" && v.trim().length > 0;

function fail(file, field) { throw new Error(`${file}: invalid or missing ${field}`); }

function validateArrays(value, schema, file) {
  for (const [key, fields] of Object.entries(schema)) {
    if (!Array.isArray(value[key])) fail(file, key);
    value[key].forEach((item, i) => {
      if (fields === null) {
        if (!string(item)) fail(file, `${key}[${i}]`);
      } else {
        if (!object(item)) fail(file, `${key}[${i}]`);
        for (const field of fields) if (!string(item[field])) fail(file, `${key}[${i}].${field}`);
      }
    });
  }
}

function readJson(dir, name) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(join(dir, name), "utf8")); }
  catch (error) { throw new Error(`${name}: cannot read JSON`, { cause: error }); }
  if (!object(parsed)) fail(name, "object");
  return parsed;
}

/** Read and validate every input before the caller writes any projection. */
export function loadDigestInput(dir, { allowPartial = false } = {}) {
  const names = readdirSync(dir).filter((f) => /^map-.*\.json$/.test(f)).sort();
  if (!names.length) throw new Error("No map-*.json inputs found");
  const maps = names.map((file) => {
    const name = file.slice(4, -5);
    if (!REPOSITORIES.includes(name)) throw new Error(`${file}: unknown repository`);
    const m = readJson(dir, file);
    if (m.repo !== name) fail(file, "repo (must match filename)");
    if (!string(m.purpose)) fail(file, "purpose");
    for (const field of ["deployment", "sharedConventions"]) if (!object(m[field])) fail(file, field);
    validateArrays(m, ARRAYS, file);
    return { name, m };
  });
  const scouts = {};
  for (const [file, schema] of Object.entries(SCOUTS)) {
    if (!existsSync(join(dir, file))) continue;
    const scout = readJson(dir, file);
    if (!string(scout.summary)) fail(file, "summary");
    validateArrays(scout, schema, file);
    // Nested collections are consumed by the renderer as arrays too.
    for (const [i, concern] of (scout.concerns ?? []).entries()) {
      validateArrays(concern, { occurrences: ["repo", "file"] }, `${file}:concerns[${i}]`);
    }
    for (const [i, lib] of (scout.vendoredLibs ?? []).entries()) {
      validateArrays(lib, { repos: null }, `${file}:vendoredLibs[${i}]`);
    }
    scouts[file] = scout;
  }
  const missingMaps = REPOSITORIES.filter((name) => !maps.some((m) => m.name === name));
  const missingScouts = Object.keys(SCOUTS).filter((file) => !scouts[file]);
  const partial = missingMaps.length > 0 || missingScouts.length > 0;
  if (partial && !allowPartial) throw new Error(
    `Incomplete review. Missing maps: ${missingMaps.join(", ") || "none"}; scouts: ${missingScouts.join(", ") || "none"}. Use --allow-partial to label partial output explicitly.`,
  );
  const coverage = [
    `> Review coverage: ${partial ? "PARTIAL / 未完了" : "complete inputs (findings still require verification)"}`,
    `> Maps (${maps.length}/${REPOSITORIES.length}): ${maps.map((m) => m.name).join(", ")}`,
    `> Missing maps: ${missingMaps.join(", ") || "none"}`,
    `> Missing scouts: ${missingScouts.join(", ") || "none"}`, "", "",
  ].join("\n");
  return { maps, scoutDup: scouts["scout-duplicated-infra.json"] ?? null,
    scoutReg: scouts["scout-registries-and-edges.json"] ?? null, coverage,
    notes: existsSync(join(dir, "notes-fable.md")) ? readFileSync(join(dir, "notes-fable.md"), "utf8") : "" };
}
