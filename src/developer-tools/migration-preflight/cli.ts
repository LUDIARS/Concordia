import type { MigrationPreflightReport } from "./preflight.js";

interface CliResult { exitCode: number; stdout: string; stderr: string }
const usage = "Usage: npm run migration:preflight -- [ref]\nCommitted schema only; default ref: HEAD.\n";

export function runMigrationPreflightCli(
  args: readonly string[], run: (ref: string) => MigrationPreflightReport,
): CliResult {
  if (args.length === 1 && args[0] === "--help") return { exitCode: 0, stdout: usage, stderr: "" };
  if (args.length > 1 || args[0]?.startsWith("-")) return { exitCode: 2, stdout: "", stderr: usage };
  try {
    const report = run(args[0] ?? "HEAD");
    return { exitCode: report.comparisons.some(item => item.collisions.length > 0) ? 1 : 0,
      stdout: JSON.stringify(report, null, 2) + "\n", stderr: "" };
  } catch (error) {
    return { exitCode: 2, stdout: "",
      stderr: `migration preflight: ${error instanceof Error ? error.message : String(error)}\n` };
  }
}
