// @spec Cc script creator contract validation
/** Pure validation of registered commands. Permissions describe effects, not grants. */
export const PERMISSIONS = ['workspace-read', 'workspace-write', 'network', 'service-control', 'external-publish'];

export function validateId(id) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(id)) throw new Error('Invalid command/run ID');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)) throw new Error('Reserved command/run ID');
  return id;
}

function text(value, name, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

export function validateDefinition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Definition must be an object');
  const allowed = ['id', 'description', 'arguments', 'requiredPermissions', 'script', 'test'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Unknown definition field');
  const id = validateId(input.id);
  const description = text(input.description, 'description', 2000);
  if (!Array.isArray(input.arguments) || input.arguments.length > 30) throw new Error('Invalid arguments declaration');
  const args = input.arguments.map(arg => {
    if (!arg || Object.keys(arg).some(key => !['name', 'required'].includes(key))) throw new Error('Invalid argument declaration');
    const name = validateId(arg.name);
    if (typeof arg.required !== 'boolean') throw new Error('Argument required must be boolean');
    return { name, required: arg.required };
  });
  if (new Set(args.map(arg => arg.name)).size !== args.length) throw new Error('Duplicate argument');
  const permissions = input.requiredPermissions;
  if (!Array.isArray(permissions) || !permissions.length || permissions.some(p => !PERMISSIONS.includes(p))) {
    throw new Error('Declare requiredPermissions explicitly');
  }
  return {
    manifest: { version: 1, id, description, arguments: args, requiredPermissions: [...new Set(permissions)].sort() },
    script: text(input.script, 'script', 256_000),
    test: text(input.test, 'test', 256_000),
  };
}

export function validateArguments(manifest, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Arguments must be an object');
  const names = new Set(manifest.arguments.map(arg => arg.name));
  if (Object.keys(values).some(name => !names.has(name))) throw new Error('Unknown argument');
  const result = {};
  for (const arg of manifest.arguments) {
    const value = Object.hasOwn(values, arg.name) ? values[arg.name] : undefined;
    if (value === undefined) {
      if (arg.required) throw new Error(`Missing argument: ${arg.name}`);
    } else {
      if (typeof value !== 'string' || value.length > 16_384 || value.includes('\0')) throw new Error(`Invalid argument: ${arg.name}`);
      result[arg.name] = value;
    }
  }
  return result;
}

export function requireDigest(actual, expected) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || expected !== actual) {
    throw new Error('Definition changed or inspected digest missing; inspect and verify this version');
  }
}
