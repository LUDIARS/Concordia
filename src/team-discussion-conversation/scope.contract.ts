export default {
  post(result: boolean, input: { human: boolean; publicChannel: boolean; ownedSurface: boolean; hasContent: boolean }): boolean {
    return result === !(!input.ownedSurface || !input.human || !input.hasContent || !input.publicChannel);
  },
};
