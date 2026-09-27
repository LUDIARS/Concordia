/** RWF uses the core engine; customization is local skill / workflow data. */
import * as bundled from "./reaction-workflow.js";
export type RwfModule = typeof bundled;
let initialized = false;

/** @implements CC-RWF-DATA-01 — never import executable code from a second repository. */
export async function initReactionWorkflow(
  _workspaceRoot: string | null | undefined,
  log: { info: (message: string) => void; warn: (message: string) => void },
): Promise<void> {
  if (initialized) return;
  initialized = true;
  if (process.env.CONCORDIA_RWF_PLUGIN_PATH?.trim()) {
    log.warn("RWF external plugin loading is retired. Move customizations to local skills and workflow data.");
  }
  log.info("RWF uses the Concordia engine and local workflow data.");
}
export function getRwf(): RwfModule { return bundled; }
export function _resetReactionWorkflowLoader(): void { initialized = false; }
