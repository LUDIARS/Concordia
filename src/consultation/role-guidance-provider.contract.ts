/** @implements SPEC-CONSULT-PROJECTLESS */
/** C-1: only providers that cannot read the role folder themselves (anything but claude) get the inline guidance. */
export default {
  post(result: unknown, provider?: unknown): boolean {
    return result === (provider !== "claude");
  },
};
