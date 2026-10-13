/**
 * Forum template launch policy for Codex on Satelles (codex-sdk).
 *
 * - Satelles has no consult confinement lane (`confinementArgsFor` only knows
 *   `claude` / `codex`), so a projectless consult keeps the terminal `codex`
 *   lane with its read-only confinement instead of being refused.
 * - A Cc-managed forum template launched on Satelles may receive the
 *   operator's danger-full-access sandbox, like a delegation run. Consult
 *   launches never do.
 *
 * @implements spec/feature/delegation.md §4
 */

export interface ForumSessionLaunchInput {
  /** Template `target_provider` (logical provider). */
  targetProvider: string;
  /** Template `forum_tag` (0/1 column or boolean). */
  forumTag: boolean | number | null | undefined;
  /** True when the launch is a confined projectless consult. */
  consultConfined: boolean;
}

/** Logical provider to launch: confined consults fall back from Satelles to the terminal Codex lane. */
export function forumLaunchProvider(input: Pick<ForumSessionLaunchInput, "targetProvider" | "consultConfined">): string {
  if (input.consultConfined && input.targetProvider === "codex-sdk") return "codex";
  return input.targetProvider;
}

/** Whether the launch may receive the elevated Satelles sandbox. */
export function forumSessionHostAccess(input: ForumSessionLaunchInput): boolean {
  if (input.consultConfined) return false;
  if (!(input.forumTag === true || input.forumTag === 1)) return false;
  return forumLaunchProvider(input) === "codex-sdk";
}
