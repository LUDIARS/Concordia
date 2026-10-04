/** C-13: private consultation material must never reach the specification feed. */
export default {
  post(result: unknown, _ports: unknown, input: { privateConsultation?: boolean }): boolean {
    return input.privateConsultation !== true
      || (result as { state?: string })?.state === "excluded_private";
  },
};
