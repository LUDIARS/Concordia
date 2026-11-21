export default {
  post(result: unknown, key: unknown, commit: unknown): boolean {
    const parts = String(key).split(":");
    const valid = parts[0] === "cf-build" && !!parts[1] && !!parts[2] && parts[3] === commit
      && /^[0-9a-f]{7,40}$/.test(parts[3])
      && (parts.length === 4 || (parts.length === 5 && /^retry-[1-9][0-9]*$/.test(parts[4])));
    if (!valid) return result === null;
    const identity = result as { projectCode?: unknown; variantId?: unknown } | null;
    return identity?.projectCode === parts[1] && identity.variantId === parts[2];
  },
};
