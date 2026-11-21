import type { AgyGeneration } from "./agy-usage-metadata.js";
import type { UsageWindow } from "./windowed-usage.js";

export default {
  post(
    result: Record<string, number>,
    generations: readonly AgyGeneration[],
    windows: readonly UsageWindow[],
  ): boolean {
    return windows.every(({ key, startSec, endSec }) => result[key] === generations
      .filter(({ atMs }) => atMs !== null && startSec <= atMs / 1000 && atMs / 1000 < endSec)
      .reduce((sum, row) => sum + row.total, 0));
  },
};
