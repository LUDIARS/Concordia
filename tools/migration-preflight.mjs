import { GitMigrationRepository, gitReader } from "../src/developer-tools/migration-preflight/git.ts";
import { preflightMigrations } from "../src/developer-tools/migration-preflight/preflight.ts";
import { runMigrationPreflightCli } from "../src/developer-tools/migration-preflight/cli.ts";

const repository = new GitMigrationRepository(gitReader(process.cwd()));
const result = runMigrationPreflightCli(process.argv.slice(2), ref => preflightMigrations(repository, ref));
if (result.stdout) process.stdout.write(result.stdout, "utf8");
if (result.stderr) process.stderr.write(result.stderr, "utf8");
process.exitCode = result.exitCode;
