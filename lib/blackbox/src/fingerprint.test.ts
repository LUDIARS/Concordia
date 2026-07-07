import { describe, expect, it } from 'vitest';
import { canonicalJson, ruleFingerprint, sameOutput } from './fingerprint.js';

describe('fingerprint', () => {
  it('キー順が違っても同じ指紋になる', () => {
    const a = ruleFingerprint({ op: 'cmp', feature: 'dow', cmp: '==', value: 2 }, { names: ['x'] });
    const b = ruleFingerprint({ value: 2, cmp: '==', op: 'cmp', feature: 'dow' }, { names: ['x'] });
    expect(a).toBe(b);
  });

  it('論理内容が違えば指紋も違う', () => {
    const a = ruleFingerprint({ op: 'cmp', feature: 'dow', cmp: '==', value: 2 }, { names: ['x'] });
    const b = ruleFingerprint({ op: 'cmp', feature: 'dow', cmp: '==', value: 3 }, { names: ['x'] });
    expect(a).not.toBe(b);
  });

  it('sameOutput はキー順に依存しない deep equal', () => {
    expect(sameOutput({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameOutput({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameOutput(undefined, null)).toBe(true); // undefined は null に正規化
  });

  it('canonicalJson は配列順を保持する', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });
});
