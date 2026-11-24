export default {
  post(result: { kind: string }, raw: unknown, registered: ReadonlySet<string>): boolean {
    const value = raw as Record<string, unknown> | null;
    const text = (field: string, max: number) => typeof value?.[field] === "string"
      && (value[field] as string).trim().length > 0 && (value[field] as string).length <= max;
    if (result.kind !== "cloud_fix") return true;
    return value?.kind === "cloud_fix" && typeof value.target_repo === "string"
      && registered.has(value.target_repo) && text("title", 120) && text("reason", 500) && text("instruction", 3000);
  },
};
