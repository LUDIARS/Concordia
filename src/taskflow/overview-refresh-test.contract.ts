import type { TaskOverviewScan } from "./store.js";

export default {
  post(result: TaskOverviewScan): boolean {
    return result.freshness?.refreshing === false;
  },
};
