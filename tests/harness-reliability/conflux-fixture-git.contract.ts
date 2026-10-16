/** CF-FIXTURE-HOOKS: command-scoped hook isolation only. */
export default {
  post(result: unknown, args: string[], hooks: string): boolean {
    return Array.isArray(result)
      && result.length === args.length + 2
      && result[0] === "-c"
      && result[1] === `core.hooksPath=${hooks}`
      && args.every((arg, index) => result[index + 2] === arg);
  },
};
