/** @implements spec/feature/usage-budgets.md §3.2 — budget-C-2 指示を出した人ごとの帰属 */
/**
 * budget-C-2: a charge that leaves the launch subject goes only to the user budget of the person
 * who gave that instruction, and only when the launcher is known and is someone else. No tokens
 * are created: the charged total never exceeds the observed total.
 */
interface Subject { scope: string; targetId: string }
interface Charge { subject: Subject; personUserId: string | null; tokens: number }

export default {
  post(result: unknown, attribution: unknown, points: unknown): boolean {
    const charges = result as Charge[];
    const input = attribution as { defaultSubject: Subject | null; launcherUserId: string | null };
    if (!Array.isArray(charges) || !input) return false;
    const observed = (points as Array<{ tokens: number }>).reduce((sum, point) => sum + (point.tokens > 0 ? point.tokens : 0), 0);
    const charged = charges.reduce((sum, charge) => sum + charge.tokens, 0);
    if (charged > observed + 1e-9) return false;
    return charges.every((charge) => {
      const sameAsDefault = input.defaultSubject !== null
        && charge.subject.scope === input.defaultSubject.scope && charge.subject.targetId === input.defaultSubject.targetId;
      if (sameAsDefault) return true;
      return input.launcherUserId !== null
        && charge.subject.scope === "user"
        && charge.subject.targetId === charge.personUserId
        && charge.personUserId !== input.launcherUserId;
    });
  },
};
