// @spec Cc script creator command routing
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson } from './storage.mjs';
import { createDefinition, inspectDefinition, listDefinitions, runDefinition, verifyDefinition } from './service.mjs';

export const OPERATIONS = ['script:create', 'script:inspect', 'script:list', 'script:verify', 'script:run'];

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--repo', '--request', '--id', '--digest', '--arguments', '--run-id'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || key in result) {
      throw new Error(`Invalid option: ${key}`);
    }
    result[key] = argv[i + 1];
  }
  return result;
}

export async function dispatch(name, argv) {
  if (!OPERATIONS.includes(name)) throw new Error('Unknown script operation');
  const args = options(argv);
  if (!args['--repo']) throw new Error('--repo is required');
  const repo = resolve(args['--repo']);
  if (name === 'script:list') return listDefinitions(repo);
  if (name === 'script:create') {
    if (!args['--request']) throw new Error('--request UTF-8 JSON file is required');
    return createDefinition(repo, await readJson(resolve(args['--request'])));
  }
  if (name === 'script:inspect') return inspectDefinition(repo, args['--id']);
  if (name === 'script:verify') return verifyDefinition(repo, args['--id'], args['--digest']);
  const values = args['--arguments'] ? await readJson(resolve(args['--arguments'])) : {};
  return runDefinition(repo, args['--id'], args['--digest'], values, args['--run-id']);
}

export async function main(argv) {
  try {
    const result = await dispatch(argv[0], argv.slice(1));
    process.stdout.write(JSON.stringify(result) + '\n');
    return result?.status && result.status !== 'success' ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
