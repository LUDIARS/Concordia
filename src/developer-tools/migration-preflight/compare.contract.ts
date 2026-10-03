/** C-13: independently enumerate the conflicting pairs, including their identities. */
interface Entry { version: number; name: string; definition: string }
export default {
  post(result: unknown, left: readonly Entry[], right: readonly Entry[], ancestor: readonly Entry[]): boolean {
    if (!Array.isArray(result)) return false;
    const expected = left.flatMap(a => right.filter(b => a.version === b.version
      && a.definition !== b.definition
      && (!ancestor.some(c => c.version === a.version && c.definition === a.definition)
        || !ancestor.some(c => c.version === b.version && c.definition === b.definition)))
      .map(b => ({ version: a.version, leftName: a.name, rightName: b.name })))
      .sort((a, b) => a.version - b.version);
    return JSON.stringify(result) === JSON.stringify(expected);
  },
};
