import type { InputSchemaItem } from "../db/delegation-repo.js";

const VAR_RE = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::([^}]*))?\}/g;

export interface RenderResult {
  rendered: string;
  missing: string[];
  unknown_vars: string[];
}

export function substituteVars(s: string, args: Record<string, unknown>): string {
  return s.replace(VAR_RE, (_match, name: string, fallback?: string) => {
    const value = args[name];
    if (value !== undefined && value !== null && value !== "") return String(value);
    return fallback ?? "";
  });
}

export function renderTemplate(
  template: string,
  args: Record<string, unknown>,
  schema: InputSchemaItem[],
): RenderResult {
  const missing: string[] = [];
  const unknown = new Set<string>();
  const required = new Set(schema.filter((item) => item.required).map((item) => item.name));
  const known = new Set(schema.map((item) => item.name));
  const filledArgs: Record<string, unknown> = { ...args };
  for (const item of schema) {
    if (filledArgs[item.name] === undefined && item.default !== undefined) {
      filledArgs[item.name] = item.default;
    }
  }
  for (const name of required) {
    const value = filledArgs[name];
    if (value === undefined || value === null || value === "") missing.push(name);
  }
  const rendered = template.replace(VAR_RE, (_match, name: string, fallback?: string) => {
    if (!known.has(name)) unknown.add(name);
    const value = filledArgs[name];
    if (value !== undefined && value !== null && value !== "") return String(value);
    return fallback ?? "";
  });
  return { rendered, missing, unknown_vars: [...unknown] };
}

export function validateArgs(
  args: Record<string, unknown>,
  schema: InputSchemaItem[],
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const item of schema) {
    const value = args[item.name];
    if (value === undefined || value === null) {
      if (item.required && item.default === undefined) errors.push(`missing required arg: ${item.name}`);
      continue;
    }
    const type = typeof value;
    if (item.type === "string" && type !== "string") errors.push(`arg ${item.name} must be string`);
    if (item.type === "number" && type !== "number") errors.push(`arg ${item.name} must be number`);
    if (item.type === "boolean" && type !== "boolean") errors.push(`arg ${item.name} must be boolean`);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
