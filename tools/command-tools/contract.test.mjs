import { describe, expect, it } from 'vitest';
import { requireDigest, validateArguments, validateDefinition, validateId } from './contract.mjs';

const definition = () => ({ id: 'hello', description: '挨拶する', arguments: [{ name: 'name', required: true }], requiredPermissions: ['workspace-read'], script: 'export {}', test: 'export {}' });

describe('registered script contract', () => {
  it('rejects traversal, reserved Windows paths and malformed definitions', () => {
    for (const id of ['../hello', 'C:/x', 'CON', 'nul', '', 'x/y']) expect(() => validateId(id)).toThrow();
    expect(() => validateDefinition({ ...definition(), executable: 'powershell' })).toThrow('Unknown');
    expect(() => validateDefinition({ ...definition(), requiredPermissions: [] })).toThrow('requiredPermissions');
    expect(() => validateDefinition({ ...definition(), arguments: [{ name: 'x', required: true }, { name: 'x', required: false }] })).toThrow('Duplicate');
  });
  it('validates required and unexpected arguments without interpreting shell characters', () => {
    const { manifest } = validateDefinition(definition());
    expect(() => validateArguments(manifest, {})).toThrow('Missing');
    expect(() => validateArguments(manifest, { name: 'ok', extra: 'bad' })).toThrow('Unknown');
    expect(validateArguments(manifest, { name: '日本語; $(exit)' })).toEqual({ name: '日本語; $(exit)' });
    expect(() => validateArguments(manifest, { name: 2 })).toThrow('Invalid');
  });
  it('requires exact inspected content version', () => {
    expect(() => requireDigest('a'.repeat(64), undefined)).toThrow();
    expect(() => requireDigest('a'.repeat(64), 'b'.repeat(64))).toThrow();
    expect(() => requireDigest('a'.repeat(64), 'a'.repeat(64))).not.toThrow();
  });
  it('does not mistake inherited object properties for supplied arguments', () => {
    const { manifest } = validateDefinition({ ...definition(), arguments: [{ name: 'constructor', required: false }] });
    expect(validateArguments(manifest, {})).toEqual({});
    expect(validateArguments(manifest, { constructor: 'literal' })).toEqual({ constructor: 'literal' });
  });
});
