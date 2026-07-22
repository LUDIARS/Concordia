import { parseInputSchema } from "../db/delegation-repo.js";
import { renderTemplate, validateArgs } from "./prompt.js";

export type InvocationPlan =
  | { ok: true; renderedPrompt: string }
  | { ok: false; error: string; details: unknown };

export function buildInvocationPlan(
  definition: { input_schema: string; prompt_template: string },
  input: {
    args?: Record<string, unknown>;
    extra_prompt?: string;
    memory_links?: string[];
  },
): InvocationPlan {
  const args = input.args ?? {};
  const schema = parseInputSchema(definition.input_schema);
  const validation = validateArgs(args, schema);
  if (!validation.ok) return { ok: false, error: "invalid args", details: validation.errors };
  const render = renderTemplate(definition.prompt_template, args, schema);
  if (render.missing.length > 0) {
    return { ok: false, error: "missing required args", details: render.missing };
  }
  const extra = (input.extra_prompt ?? "").trim();
  const withExtra = extra
    ? `${render.rendered}\n\n---\n\n## 追加の初回指示（人間）\n\n${extra}`
    : render.rendered;
  const links = (input.memory_links ?? []).map((link) => link.trim()).filter(Boolean);
  return {
    ok: true,
    renderedPrompt: links.length > 0
      ? `${withExtra}\n\n## 参照メモリ (必要な分だけ読むこと)\n\n${links.map((link) => `- ${link}`).join("\n")}`
      : withExtra,
  };
}
