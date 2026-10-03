/**
 * User-facing projection policy; execution and raw event delivery are independent.
 * @implements SPEC-SESSION-END-INJECT-VISIBILITY — SEI-VIS-01/02
 * @see spec/feature/session-end-inject-visibility.md
 */
export function shouldDisplaySessionInject(source: string | null | undefined): boolean {
  return source !== "auto:session-end";
}
