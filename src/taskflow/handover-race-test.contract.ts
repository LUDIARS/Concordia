export default {
  post(results: PromiseSettledResult<void>[]): boolean {
    return results.length === 2 && results.filter((result) => result.status === "fulfilled").length === 1;
  },
};
