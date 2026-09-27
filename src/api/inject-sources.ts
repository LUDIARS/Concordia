import { Hono, type Context } from "hono";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { InjectSourceError, type MajorInjectEditor } from "../control/major-inject-editor.js";

const WriteSchema = z.object({ content: z.string(), expected_revision: z.string().length(64) }).strict();
const RestoreSchema = z.object({ expected_revision: z.string().length(64) }).strict();

export function injectSourcesRouter(editor: MajorInjectEditor): Hono {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ error: "request_too_large" }, 413) }));
  app.get("/", (c) => {
    const sources = editor.list();
    const labels: Record<string, string> = {
      session: "セッション", delegation: "委託", rules: "関連ルール",
      startup: "起動", normal: "通常", escalation: "エスカレーション",
      launch: "起動", implementation: "実装", parttimer: "パートタイマー",
      manual: "kind 別マニュアル", template: "個別テンプレート", file: "参照ファイル",
    };
    const workflows = ["session", "delegation", "rules"].map((id) => ({
      id, label: labels[id] ?? id, cases: [...new Set(sources.filter((source) => source.workflow === id).map((source) => source.case))]
        .map((caseId) => ({ id: caseId, label: labels[caseId] ?? caseId })),
    }));
    return c.json({ workflows, sources });
  });
  app.get("/:id", async (c) => {
    try { return c.json({ source: await editor.get(c.req.param("id")) }); }
    catch (error) { return sourceError(c, error); }
  });
  app.put("/:id", async (c) => {
    const parsed = WriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    try { return c.json({ source: await editor.put(c.req.param("id"), parsed.data.content, parsed.data.expected_revision) }); }
    catch (error) { return sourceError(c, error); }
  });
  app.post("/:id/restore", async (c) => {
    const parsed = RestoreSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    try { return c.json({ source: await editor.restore(c.req.param("id"), parsed.data.expected_revision) }); }
    catch (error) { return sourceError(c, error); }
  });
  return app;
}

function sourceError(c: Context, error: unknown) {
  if (!(error instanceof InjectSourceError)) throw error;
  if (error.status === 409) return c.json({ error: error.code, source: error.detail }, 409);
  if (error.status === 404) return c.json({ error: error.code }, 404);
  return c.json({ error: error.code, detail: error.detail }, 400);
}
