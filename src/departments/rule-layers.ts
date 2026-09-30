/**
 * 着手前ルール供給で渡す自然文ルールを「全体 → 部署 → チーム」の順に重ねる純関数。
 *
 * 部署は会社の下・チームの上に位置するため、 部署の方針はチーム固有の方針より先に
 * 読ませる。 他部署・他チームに絞ったルールは混ぜない (別部署の作業方針が届くと、
 * 担当外の制約でセッションが止まる)。
 *
 * @implements spec/feature/departments.md §6
 * @implements SPEC-DEPT-RULE-LAYERS
 */

export interface SuppliedRule {
  kind: "allow" | "block";
  title: string;
  description: string;
}

export interface ScopedRule extends SuppliedRule {
  team_id: string | null;
  /** 部署導入前に作った行の読み出し型では欠けることがある (= 部署に絞らない)。 */
  department_id?: string | null;
}

export interface RuleScope {
  teamId: string | null;
  departmentId: string | null;
}

export interface DepartmentRuleSource {
  id: string;
  name: string;
  rules_text: string;
}

export function layerSessionRules(
  rules: readonly ScopedRule[],
  scope: RuleScope,
  department: DepartmentRuleSource | null,
): SuppliedRule[] {
  const globalRules = rules.filter((rule) => !rule.team_id && !rule.department_id);
  const departmentRules = scope.departmentId
    ? rules.filter((rule) => !rule.team_id && rule.department_id === scope.departmentId)
    : [];
  const teamRules = scope.teamId
    ? rules.filter((rule) => rule.team_id === scope.teamId)
    : [];
  const departmentText = department && department.id === scope.departmentId
    ? departmentRulesTextEntry(department)
    : [];
  return [...globalRules, ...departmentText, ...departmentRules, ...teamRules].map(toSupplied);
}

/** 部署の rules_text を 1 項目として表す。 空なら何も足さない。 */
export function departmentRulesTextEntry(department: DepartmentRuleSource): SuppliedRule[] {
  const text = department.rules_text.trim();
  if (!text) return [];
  return [{ kind: "block", title: `部署ルール: ${department.name}`, description: text }];
}

function toSupplied(rule: SuppliedRule): SuppliedRule {
  return { kind: rule.kind, title: rule.title, description: rule.description };
}
