import { readFile } from "node:fs/promises";

// Contract instrumentation shares the service runtime. Disable its persistent sinks
// before loading it so this standalone reader cannot create/rotate service logs.
process.env.CONCORDIA_VESTIGIUM = "0";
process.env.CONCORDIA_LOG_FILE = "0";
const { runStatusPreflightCli } = await import("../src/delegation/status-preflight-cli.ts");

const result = await runStatusPreflightCli(process.argv.slice(2), path => readFile(path, "utf8"));
if (result.stdout) process.stdout.write(result.stdout, "utf8");
if (result.stderr) process.stderr.write(result.stderr, "utf8");
process.exitCode = result.exitCode;
