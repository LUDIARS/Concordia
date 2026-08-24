/** @implements spec/feature/dependency-readiness.md — Excubitor-backed readiness model */
import type { ExcubitorClient, ExcubitorService } from "../excubitor/client.js";

export type DependencyReadinessState = "ok" | "warn" | "error";

export interface DependencyReadinessItem {
  project: string;
  serviceCode: string;
  configured: boolean;
  running: boolean;
  reachable: boolean | null;
  requiredRunning: boolean;
  state: DependencyReadinessState;
  detail: string;
}

export interface DependencyReadinessReport {
  checkedAt: string;
  excubitorReachable: boolean;
  items: DependencyReadinessItem[];
  error?: "excubitor_unreachable";
}

interface DependencyDefinition {
  project: string;
  serviceCodes: readonly string[];
  requiredRunning: boolean;
  requiresRevisorWorkflowToken?: boolean;
}

const RUNNING_STATES = new Set(["running", "healthy"]);

const DEPENDENCIES: readonly DependencyDefinition[] = [
  { project: "Anatomia", serviceCodes: ["anatomia"], requiredRunning: true },
  // Augur is daemon-optional: its CLI/MCP path remains usable while the HTTP shell is stopped.
  { project: "Augur", serviceCodes: ["augur"], requiredRunning: false },
  { project: "Memoria", serviceCodes: ["memoria-server", "memoria"], requiredRunning: true },
  // Actio integration is intentionally reported independently from Memoria so a missing Phase 4
  // adapter/catalog cannot be mistaken for a healthy Memoria fallback.
  { project: "Actio", serviceCodes: ["actio"], requiredRunning: false },
  {
    project: "Revisor",
    serviceCodes: ["revisor"],
    requiredRunning: true,
    requiresRevisorWorkflowToken: true,
  },
] as const;

export interface DependencyReadinessOptions {
  excubitor: Pick<ExcubitorClient, "listServices" | "isAlive">;
  hasRevisorWorkflowToken: () => boolean;
  now?: () => Date;
}

export function createDependencyReadinessChecker(
  options: DependencyReadinessOptions,
): () => Promise<DependencyReadinessReport> {
  return () => checkDependencyReadiness(options);
}

export async function checkDependencyReadiness(
  options: DependencyReadinessOptions,
): Promise<DependencyReadinessReport> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  let services: ExcubitorService[];
  try {
    services = await options.excubitor.listServices();
  } catch {
    return {
      checkedAt,
      excubitorReachable: false,
      items: [],
      error: "excubitor_unreachable",
    };
  }

  const items = await Promise.all(DEPENDENCIES.map(async (definition) => {
    const service = findService(services, definition.serviceCodes);
    const configurationError = definition.requiresRevisorWorkflowToken === true
      && !options.hasRevisorWorkflowToken()
      ? "workflow token is not configured"
      : null;
    return inspectDependency(options.excubitor, definition, service, configurationError);
  }));
  return { checkedAt, excubitorReachable: true, items };
}

function findService(
  services: readonly ExcubitorService[],
  acceptedCodes: readonly string[],
): ExcubitorService | null {
  for (const code of acceptedCodes) {
    const service = services.find((candidate) => candidate.code.toLowerCase() === code.toLowerCase());
    if (service) return service;
  }
  return null;
}

async function inspectDependency(
  excubitor: Pick<ExcubitorClient, "isAlive">,
  definition: DependencyDefinition,
  service: ExcubitorService | null,
  configurationError: string | null,
): Promise<DependencyReadinessItem> {
  const fallbackCode = definition.serviceCodes[0]!;
  if (!service) {
    return {
      project: definition.project,
      serviceCode: fallbackCode,
      configured: false,
      running: false,
      reachable: null,
      requiredRunning: definition.requiredRunning,
      state: "error",
      detail: "Excubitor catalog entry is missing",
    };
  }

  const running = RUNNING_STATES.has(service.state.toLowerCase());
  let reachable: boolean | null = null;
  let probeFailed = false;
  try {
    reachable = await excubitor.isAlive(service.code);
  } catch {
    probeFailed = true;
  }

  const configured = configurationError === null;
  const state = readinessState({
    configured,
    running,
    reachable,
    requiredRunning: definition.requiredRunning,
  });
  const detail = [
    configurationError,
    probeFailed ? "liveness lookup failed" : null,
    `catalog=${service.code}`,
    `runtime=${service.state}`,
    `health=${reachable === null ? "unknown" : reachable ? "ok" : "ng"}`,
    !definition.requiredRunning && !running ? "daemon optional" : null,
  ].filter((value): value is string => Boolean(value)).join("; ");

  return {
    project: definition.project,
    serviceCode: service.code,
    configured,
    running,
    reachable,
    requiredRunning: definition.requiredRunning,
    state,
    detail,
  };
}

function readinessState(input: {
  configured: boolean;
  running: boolean;
  reachable: boolean | null;
  requiredRunning: boolean;
}): DependencyReadinessState {
  if (!input.configured) return "error";
  if (input.requiredRunning && (!input.running || input.reachable !== true)) return "error";
  if (!input.running || input.reachable !== true) return "warn";
  return "ok";
}
