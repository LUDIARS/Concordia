// @spec Cc script creator bounded process execution
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** Bounded local Node execution; no shell and no implicit retry. */
export async function executeNode({ cwd, argv, timeoutMs = 60_000, outputLimit = 262_144 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('Invalid process timeout');
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, argv, {
      cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', bytes = 0, stopped = null, spawnError = null, termination = null;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const terminate = reason => {
      if (stopped) return;
      stopped = reason;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        termination = new Promise(done => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => { child.kill('SIGKILL'); done(); });
          killer.once('close', () => { child.kill('SIGKILL'); done(); });
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
      }
    };
    const onInterrupt = () => terminate('cancelled');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    const timer = setTimeout(() => terminate('timeout'), timeoutMs);
    const collect = (chunk, stream) => {
      const remaining = Math.max(0, outputLimit - bytes);
      bytes += chunk.length;
      const value = decoders[stream].write(chunk.subarray(0, remaining));
      if (stream === 'stdout') stdout += value;
      else stderr += value;
      if (bytes > outputLimit) terminate('output-limit');
    };
    child.stdout.on('data', chunk => collect(chunk, 'stdout'));
    child.stderr.on('data', chunk => collect(chunk, 'stderr'));
    child.once('error', error => { spawnError = error; });
    child.once('close', async (exitCode, signal) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
      if (termination) await termination;
      if (spawnError) { reject(spawnError); return; }
      stdout += decoders.stdout.end();
      stderr += decoders.stderr.end();
      resolve({ status: stopped ? 'unknown' : exitCode === 0 ? 'success' : 'failed', exitCode, signal, reason: stopped, stdout, stderr });
    });
  });
}
