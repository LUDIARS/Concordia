import {
  anatomiaBaseUrl as resolveAnatomiaBaseUrl,
  thaleiaBaseUrl as resolveThaleiaBaseUrl,
} from "../config/service-urls.js";
import { trimmedEnv } from "../config/env-parse.js";
import type { PromptAnalysis } from "./local-prompt-analyzer.js";

export interface PromptResearchOptions {
  anatomiaBaseUrl?: string;
  thaleiaBaseUrl?: string;
  threshold?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface GraphResearchSummary {
  ok: boolean;
  project: string;
  stage: "summary" | "detail";
  threshold: number;
  node_count: number;
  edge_count: number;
  related_count: number;
  term_counts: Record<string, number>;
  nodes?: Array<{ id: string; name: string; kind: string; path: string }>;
  edges?: Array<{ from: string; to: string; kind: string }>;
  error?: string;
}

export interface ThaleiaResearchSummary {
  ok: boolean;
  project: string;
  flagged_count: number;
  shown_count: number;
  truncated: boolean;
  error?: string;
}

export interface PromptResearchResult {
  enabled: boolean;
  threshold: number;
  query_terms: string[];
  projects: string[];
  anatomia: GraphResearchSummary[];
  thaleia: ThaleiaResearchSummary[];
}

interface AnatomiaGraph {
  nodes?: Array<{ id?: string; name?: string; kind?: string; path?: string; sourceRange?: { filePath?: string } }>;
  edges?: Array<{ from?: string; to?: string; kind?: string }>;
}

const DEFAULT_THRESHOLD = 30;
const DEFAULT_TIMEOUT_MS = 350;

function numberEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clean(values: string[], max = 12): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || out.some((v) => v.toLowerCase() === value.toLowerCase())) continue;
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function resolveProjects(analysis: PromptAnalysis, project?: string): string[] {
  return clean([...(analysis.target_services ?? []), project ?? ""], 6);
}

function resolveTerms(analysis: PromptAnalysis, prompt: string): string[] {
  const promptWords = prompt
    .split(/[^\p{L}\p{N}_:-]+/u)
    .filter((w) => w.length >= 3 && w.length <= 48);
  return clean([...(analysis.search_tags ?? []), ...(analysis.target_services ?? []), ...promptWords], 16);
}

async function fetchJson(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function textOfNode(node: { name: string; kind: string; path: string }): string {
  return `${node.name} ${node.kind} ${node.path}`.toLowerCase();
}

function countTerms(nodes: Array<{ name: string; kind: string; path: string }>, terms: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const term of terms) {
    const lower = term.toLowerCase();
    counts[term] = nodes.filter((n) => textOfNode(n).includes(lower)).length;
  }
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}

async function researchAnatomiaProject(
  project: string,
  terms: string[],
  opts: Required<PromptResearchOptions>,
): Promise<GraphResearchSummary> {
  try {
    const data = await fetchJson(
      `${opts.anatomiaBaseUrl.replace(/\/+$/, "")}/api/graph?project=${encodeURIComponent(project)}`,
      opts.timeoutMs,
      opts.fetchImpl,
    ) as AnatomiaGraph;
    const nodes = (data.nodes ?? []).map((n) => ({
      id: String(n.id ?? ""),
      name: String(n.name ?? ""),
      kind: String(n.kind ?? ""),
      path: String(n.path ?? n.sourceRange?.filePath ?? ""),
    })).filter((n) => n.id || n.name || n.path);
    const edges = (data.edges ?? []).map((e) => ({
      from: String(e.from ?? ""),
      to: String(e.to ?? ""),
      kind: String(e.kind ?? ""),
    })).filter((e) => e.from || e.to);
    const termCounts = countTerms(nodes, terms);
    const relatedNodes = nodes.filter((n) => terms.some((term) => textOfNode(n).includes(term.toLowerCase())));
    const relatedIds = new Set(relatedNodes.map((n) => n.id).filter(Boolean));
    const relatedEdges = edges.filter((e) => relatedIds.has(e.from) || relatedIds.has(e.to));
    const relatedCount = relatedNodes.length + relatedEdges.length;
    const detail = relatedCount <= opts.threshold;
    return {
      ok: true,
      project,
      stage: detail ? "detail" : "summary",
      threshold: opts.threshold,
      node_count: nodes.length,
      edge_count: edges.length,
      related_count: relatedCount,
      term_counts: termCounts,
      ...(detail ? { nodes: relatedNodes.slice(0, opts.threshold), edges: relatedEdges.slice(0, opts.threshold) } : {}),
    };
  } catch (e) {
    return {
      ok: false,
      project,
      stage: "summary",
      threshold: opts.threshold,
      node_count: 0,
      edge_count: 0,
      related_count: 0,
      term_counts: {},
      error: (e as Error).message,
    };
  }
}

async function researchThaleiaProject(
  project: string,
  opts: Required<PromptResearchOptions>,
): Promise<ThaleiaResearchSummary> {
  try {
    const url = `${opts.thaleiaBaseUrl.replace(/\/+$/, "")}/api/links/worklist?project=${encodeURIComponent(project)}&max=${opts.threshold}`;
    const data = await fetchJson(url, opts.timeoutMs, opts.fetchImpl) as {
      summary?: { flagged?: number; shown?: number; truncated?: boolean };
    };
    return {
      ok: true,
      project,
      flagged_count: Number(data.summary?.flagged ?? 0),
      shown_count: Number(data.summary?.shown ?? 0),
      truncated: Boolean(data.summary?.truncated),
    };
  } catch (e) {
    return {
      ok: false,
      project,
      flagged_count: 0,
      shown_count: 0,
      truncated: false,
      error: (e as Error).message,
    };
  }
}

export async function collectPromptResearch(
  analysis: PromptAnalysis,
  params: { prompt: string; project?: string },
  options: PromptResearchOptions = {},
): Promise<PromptResearchResult> {
  const threshold = options.threshold ?? numberEnv("CONCORDIA_PROMPT_RESEARCH_DETAIL_THRESHOLD", DEFAULT_THRESHOLD);
  const opts: Required<PromptResearchOptions> = {
    // prompt research 専用の向き先 (共通の ANATOMIA/THALEIA_BASE_URL より優先)。
    // 共通側の解決は config/service-urls.js が正本。
    anatomiaBaseUrl:
      options.anatomiaBaseUrl ??
      trimmedEnv(process.env.CONCORDIA_PROMPT_RESEARCH_ANATOMIA_URL) ??
      resolveAnatomiaBaseUrl(),
    thaleiaBaseUrl:
      options.thaleiaBaseUrl ??
      trimmedEnv(process.env.CONCORDIA_PROMPT_RESEARCH_THALEIA_URL) ??
      resolveThaleiaBaseUrl(),
    threshold,
    timeoutMs: options.timeoutMs ?? numberEnv("CONCORDIA_PROMPT_RESEARCH_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    fetchImpl: options.fetchImpl ?? fetch,
  };
  const projects = resolveProjects(analysis, params.project);
  const queryTerms = resolveTerms(analysis, params.prompt);
  if (projects.length === 0 || queryTerms.length === 0) {
    return { enabled: true, threshold, query_terms: queryTerms, projects, anatomia: [], thaleia: [] };
  }

  const [anatomia, thaleia] = await Promise.all([
    Promise.all(projects.map((project) => researchAnatomiaProject(project, queryTerms, opts))),
    Promise.all(projects.map((project) => researchThaleiaProject(project, opts))),
  ]);

  return { enabled: true, threshold, query_terms: queryTerms, projects, anatomia, thaleia };
}
