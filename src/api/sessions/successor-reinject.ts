/**
 * 後継セッション (relictor / handover / リポ担当) へ流す引き継ぎ inject の見出しと source の選択。
 *
 * リポ担当の依頼文は repo-brief.ts が担当であることの前置きを付けて組むので、 見出しは付けない。
 *
 * @implements spec/feature/session-auto-succession.md §3.4
 */

import type { PendingRelictorKind } from "../../control/pending-relictor.js";
import { REPO_AGENT_BRIEF_INJECT_SOURCE } from "../../control/succession/repo-agent-service.js";
import {
  HANDOVER_INJECT_SOURCE,
  HANDOVER_REINJECT_HEADER,
  RELICTOR_INJECT_SOURCE,
  RELICTOR_REINJECT_HEADER,
} from "./shared.js";

export function successorReinject(kind: PendingRelictorKind): { header: string; source: string } {
  switch (kind) {
    case "handover":
      return { header: HANDOVER_REINJECT_HEADER, source: HANDOVER_INJECT_SOURCE };
    case "repo-agent":
      return { header: "", source: REPO_AGENT_BRIEF_INJECT_SOURCE };
    case "relictor":
      return { header: RELICTOR_REINJECT_HEADER, source: RELICTOR_INJECT_SOURCE };
  }
}
