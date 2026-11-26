import type { WorkBinding } from "./project-work-actions.js";

const rich = (value: string) => Array.from({ length: Math.ceil(value.length / 1800) }, (_, i) =>
  ({ text: { content: value.slice(i * 1800, (i + 1) * 1800) } }));

export class NotionWorkPages {
  constructor(private readonly token: string, private readonly binding: WorkBinding) {}

  private async request(path: string, body: unknown, method = "POST"): Promise<unknown> {
    const response = await fetch("https://api.notion.com/v1/" + path, {
      method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: "Bearer " + this.token, "Content-Type": "application/json", "Notion-Version": "2025-09-03" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("Notion work action HTTP " + response.status);
    return response.json();
  }

  async find(source: string): Promise<string | null> {
    const page = await this.request("data_sources/" + this.binding.dataSource + "/query", {
      page_size: 2, filter: { property: "Source", url: { equals: source } },
    }) as { results: { id: string }[]; has_more: boolean };
    if (page.results.length > 1 || page.has_more) throw new Error("ambiguous Notion work reference");
    return page.results[0]?.id ?? null;
  }

  async save(source: string, text: string, id: string | null) {
    const properties = { Name: { title: rich(text.split(/\r?\n/)[0]!.slice(0, 200)) }, Request: { rich_text: rich(text) } };
    if (id) return this.request("pages/" + id, { properties }, "PATCH");
    return this.request("pages", { parent: { type: "data_source_id", data_source_id: this.binding.dataSource },
      properties: { ...properties, Source: { url: source }, Status: { status: { name: this.binding.initial } } } });
  }

  async complete(id: string, status: string) {
    await this.request("pages/" + id, { properties: { Status: { status: { name: status } } } }, "PATCH");
  }
}
