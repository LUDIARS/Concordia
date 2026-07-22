import type { SessionCardState } from "./render.js";

export function buildSlackSessionTopic(state: SessionCardState): string {
  return [state.status, `session ${state.shortId}`, state.who, state.provider, state.currentTask]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(" · ")
    .slice(0, 250);
}
