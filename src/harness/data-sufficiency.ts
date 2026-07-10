import { request } from "node:http";
import { repoLeaf } from "./predicates.js";

export interface ProjectSufficiency {
  project: string;
  anatomia: {
    present: boolean;
    functions?: number;
    domains?: number;
    links?: number;
  };
  thaleia: {
    present: boolean;
    generatedAt?: string;
    specs?: number;
    implementedSpecs?: number;
    gapCount?: number;
  };
}

export interface ProjectSufficiencyOptions {
  anatomiaBaseUrl?: string;
  thaleiaBaseUrl?: string;
  timeoutMs?: number;
}

interface JsonResponse {
  statusCode: number;
  body: unknown;
}

const DEFAULT_ANATOMIA_BASE_URL = "http://127.0.0.1:4200";
const DEFAULT_THALEIA_BASE_URL = "http://127.0.0.1:8890";
const DEFAULT_TIMEOUT_MS = 1500;

function baseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function gapCountFrom(value: Record<string, unknown>): number | undefined {
  const gaps = value.gaps;
  if (Array.isArray(gaps)) return gaps.length;
  const summary = objectField(value.summary);
  const summaryGaps = summary.gaps;
  if (Array.isArray(summaryGaps)) return summaryGaps.length;
  return numberField(summary.gapCount ?? summary.gaps);
}

async function fetchJson(url: string, timeoutMs: number): Promise<JsonResponse | null> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: JsonResponse | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    try {
      const u = new URL(url);
      const controller = new AbortController();
      timer = setTimeout(() => {
        controller.abort();
        finish(null);
      }, timeoutMs);
      const req = request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: "GET",
          agent: false,
          signal: controller.signal,
          headers: { accept: "application/json" },
        },
        (res) => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            res.resume();
            finish({ statusCode, body: null });
            return;
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => {
            try {
              finish({ statusCode, body: JSON.parse(body) as unknown });
            } catch {
              finish(null);
            }
          });
        },
      );
      req.on("error", () => finish(null));
      req.end();
    } catch {
      finish(null);
    }
  });
}

async function probeAnatomia(project: string, base: string, timeoutMs: number): Promise<ProjectSufficiency["anatomia"]> {
  const url = `${baseUrl(base)}/api/projects/${encodeURIComponent(project)}/summary`;
  const response = await fetchJson(url, timeoutMs);
  if (!response || response.statusCode !== 200) return { present: false };
  const body = objectField(response.body);
  return {
    present: true,
    functions: numberField(body.functions),
    domains: numberField(body.domains),
    links: numberField(body.links),
  };
}

async function probeThaleia(project: string, base: string, timeoutMs: number): Promise<ProjectSufficiency["thaleia"]> {
  const url = `${baseUrl(base)}/reconcile?project=${encodeURIComponent(project)}`;
  const response = await fetchJson(url, timeoutMs);
  if (!response || response.statusCode !== 200) return { present: false };
  const body = objectField(response.body);
  const summary = objectField(body.summary);
  const generatedAt = typeof body.generatedAt === "string" ? body.generatedAt : undefined;
  return {
    present: true,
    generatedAt,
    specs: numberField(summary.specs),
    implementedSpecs: numberField(summary.implementedSpecs),
    gapCount: gapCountFrom(body),
  };
}

export async function probeProjectSufficiency(
  project: string,
  opts: ProjectSufficiencyOptions = {},
): Promise<ProjectSufficiency> {
  const leaf = repoLeaf(project);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const anatomiaBaseUrl = opts.anatomiaBaseUrl ?? process.env.ANATOMIA_BASE_URL ?? DEFAULT_ANATOMIA_BASE_URL;
  const thaleiaBaseUrl = opts.thaleiaBaseUrl ?? process.env.THALEIA_BASE_URL ?? DEFAULT_THALEIA_BASE_URL;
  const [anatomia, thaleia] = await Promise.all([
    probeAnatomia(leaf, anatomiaBaseUrl, timeoutMs).catch(() => ({ present: false })),
    probeThaleia(leaf, thaleiaBaseUrl, timeoutMs).catch(() => ({ present: false })),
  ]);
  return { project: leaf, anatomia, thaleia };
}
