/** SC-WAIT observation predicates; measurements remain pending. */
export default {
  post(result: {allow:boolean}, input: {active:boolean;bindingMatches:boolean;humanWait:boolean;humanConfirmation:boolean;pendingQuestion:boolean | "unknown";residentIdle:boolean}): boolean {
    const blocked = !input.active || !input.bindingMatches || input.humanWait || input.humanConfirmation
      || input.pendingQuestion !== false || input.residentIdle;
    return result.allow === !blocked;
  },
};
