/** @implements spec/feature/daily-goal-run.md — Git 証跡の引数境界 (CC-DG-INV-03) */
export default {
  post(result: unknown, branch: unknown, since: unknown): boolean {
    const valid = typeof branch === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)
      && !branch.includes("..") && !branch.endsWith(".")
      && !branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"));
    if (!valid) return result === null;
    if (typeof since !== "number" || !Array.isArray(result)) return false;
    const expected = ["log", "--since=@" + Math.floor(since / 1000), "--format=%H%x09%ct%x09%s", "-n", "200", "--end-of-options", branch, "--"];
    return result.length === expected.length && result.every((arg, index) => arg === expected[index]);
  },
};
