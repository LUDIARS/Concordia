#!/usr/bin/env node
// Replacement for the active thin PreToolUse hook. No service startup, no shell execution.
import { spawn } from 'node:child_process';
import { join, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';

if (process.env.CONCORDIA_HARNESS_HOOKS === '1') {
  const runtime = process.env.CONCORDIA_HARNESS_RUNTIME;
  const config = process.env.CONCORDIA_HARNESS_CONFIG;
  if (!runtime || !config || !isAbsolute(runtime) || !isAbsolute(config)
    || !existsSync(join(runtime, 'harness/supervisor-cli.js')) || !existsSync(config)) {
    process.stderr.write('[harness-supervisor] Configure absolute CONCORDIA_HARNESS_RUNTIME and CONCORDIA_HARNESS_CONFIG paths before enabling this hook.\n');
    process.exitCode = 2;
  } else {
    const child = spawn(process.execPath, [join(runtime, 'harness/supervisor-cli.js'), config], {
      cwd: process.cwd(), windowsHide: true, stdio: 'inherit', shell: false,
    });
    child.on('error', (error) => { process.stderr.write(`[harness-supervisor] ${error.message}\n`); process.exitCode = 2; });
    child.on('exit', (code) => { process.exitCode = code ?? 2; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  }
}
