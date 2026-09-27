// @spec CC-REPO-SEARCH-01

export type EvidenceState = "yes" | "no" | "unknown";
export type SearchLanguage = "typescript" | "javascript" | "python" | "rust" | "cpp" | "csharp" | "go" | "java";

export interface RepositorySearchSnapshot {
  root: string;
  provider: string;
  observedAt: string;
  rootFiles: string[];
  extensions: Record<string, number>;
  sampleLimited: boolean;
  sampleReasons: string[];
  binaries: Record<string, boolean>;
  configuredServers: string[];
  pathLimited: boolean;
}

export interface SearchToolStatus {
  name: string;
  installed: EvidenceState;
  configured: EvidenceState;
  callable: "unknown";
}

export interface RepositorySearchCapabilities {
  root: string;
  provider: string;
  observedAt: string;
  scope: "cc-host";
  languages: SearchLanguage[];
  sampleLimited: boolean;
  sampleReasons: string[];
  tools: SearchToolStatus[];
}

const languageExtensions: Array<[SearchLanguage, string[]]> = [
  ["typescript", [".ts", ".tsx"]], ["javascript", [".js", ".jsx", ".mjs", ".cjs"]],
  ["python", [".py"]], ["rust", [".rs"]], ["cpp", [".cpp", ".cc", ".cxx", ".h", ".hpp"]],
  ["csharp", [".cs"]], ["go", [".go"]], ["java", [".java"]],
];

const languageServers: Partial<Record<SearchLanguage, string>> = {
  typescript: "typescript-language-server", javascript: "typescript-language-server",
  python: "pyright-langserver", rust: "rust-analyzer", cpp: "clangd",
  csharp: "csharp-ls", go: "gopls", java: "jdtls",
};

export const SEARCH_BINARY_NAMES = ["anatomia", "rg", "typescript-language-server", "pyright-langserver", "rust-analyzer", "clangd", "csharp-ls", "gopls", "jdtls"] as const;

/** Interpretation is pure: presence on the Cc host never proves an agent can invoke a tool. */
export function classifyRepositorySearch(snapshot: RepositorySearchSnapshot): RepositorySearchCapabilities {
  const files = new Set(snapshot.rootFiles.map((name) => name.toLowerCase()));
  const languages = languageExtensions.filter(([language, exts]) =>
    exts.some((ext) => (snapshot.extensions[ext] ?? 0) > 0)
    || (language === "typescript" && files.has("tsconfig.json"))
    || (language === "javascript" && files.has("package.json"))
    || (language === "rust" && files.has("cargo.toml"))
    || (language === "go" && files.has("go.mod"))
    || (language === "python" && files.has("pyproject.toml"))
  ).map(([language]) => language);
  const names = new Set(["anatomia", "rg", ...languages.map((language) => languageServers[language]).filter((name): name is string => !!name)]);
  const tools = [...names].map((name): SearchToolStatus => ({
    name,
    installed: snapshot.binaries[name] ? "yes" : snapshot.pathLimited ? "unknown" : "no",
    configured: snapshot.configuredServers.includes(name) ? "yes" : "unknown",
    callable: "unknown",
  }));
  return { root: snapshot.root, provider: snapshot.provider, observedAt: snapshot.observedAt,
    scope: "cc-host", languages, sampleLimited: snapshot.sampleLimited, sampleReasons: snapshot.sampleReasons, tools };
}

export function formatRepositorySearchGuidance(capabilities: RepositorySearchCapabilities): string {
  const languages = capabilities.languages.length ? capabilities.languages.join(", ") : "未特定";
  const tools = capabilities.tools.map((tool) => `${tool.name}(配置=${tool.installed}, 設定=${tool.configured}, 呼出=${tool.callable})`).join(", ");
  return `[Cc search environment] 対象=${capabilities.root}; 言語=${languages}; Ccホスト観測=${tools || "なし"}; 標本上限=${capabilities.sampleLimited ? `到達(${capabilities.sampleReasons.join(",")})` : "未到達"}。これはCcホストの観測であり作業先端末の実行可否は未確認です。機能調査はAnatomiaのドメイン索引が利用可能で準備済みなら先に一覧から対象ドメインを選んでください。未準備なら明示的に準備するか、作業先で利用できる検索手段を使ってください。リファクタリング・全体調査はピンポイント検索の対象外です。定義・参照確認は作業先でLSPの実呼出を確認して利用してください。`;
}
