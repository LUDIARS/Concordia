import type { AgyGeneration } from "./agy-usage-metadata.js";

export default {
  post(
    result: AgyGeneration[],
    generations: readonly AgyGeneration[],
    start: number,
    end: number,
  ): boolean {
    const within = generations.filter(({ atMs }) => atMs !== null && start <= atMs && atMs < end);
    return result.length === within.length && within.every((row, index) => result[index] === row);
  },
};
