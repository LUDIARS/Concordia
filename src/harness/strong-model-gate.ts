import { isEditTool, type Predicate } from "./predicates.js";

const DOCUMENT_EXTENSIONS = /\.(?:md|markdown|txt)$/i;
const DOCUMENT_DIRECTORIES = /(?:^|[\\/])(?:spec|docs)[\\/]/i;

export function makeStrongModelImplPredicate(models: readonly string[]): Predicate {
  const needles = models.map((model) => model.trim().toLowerCase()).filter(Boolean);
  return (action) => {
    if (!isEditTool(action.tool) || !action.filePath || action.implUnlocked === true) return null;
    if (DOCUMENT_EXTENSIONS.test(action.filePath) || DOCUMENT_DIRECTORIES.test(action.filePath)) return null;
    const model = action.sessionModel?.toLowerCase();
    if (!model || !needles.some((needle) => model.includes(needle))) return null;
    return {
      rule: "strong-model-impl",
      decision: "deny",
      reason: `強推論モデル (${action.sessionModel}) によるコード実装はロックされています。`,
      suggestion: "実装は delegation へ委託してください。直接続行する場合はユーザ承認後に impl-unlock を実行してください。",
    };
  };
}
