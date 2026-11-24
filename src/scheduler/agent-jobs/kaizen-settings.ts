export const KAIZEN_CLOUD_LIMIT_KEY = "scheduler.kaizen_cloud_max_per_run";
export const KAIZEN_DEFAULT_CLOUD_LIMIT = 3;
export const KAIZEN_MAX_CLOUD_LIMIT = 10;

export function kaizenCloudLimit(raw: string | null): number {
  const limit = Number(raw);
  return Number.isInteger(limit) && limit >= 1 && limit <= KAIZEN_MAX_CLOUD_LIMIT ? limit : KAIZEN_DEFAULT_CLOUD_LIMIT;
}
