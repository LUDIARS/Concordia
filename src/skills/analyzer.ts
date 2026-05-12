/**
 * Skill content analyzer.
 *
 * v0.1: rule-based heuristic. 各 snapshot に対して poison_score (0..1) と
 * growth_score (0..1) を算出する.
 *
 * - poison: 危険コマンド / 指示の上書き / 既知 frontmatter の改ざん /
 *   重要セクションの削除 / 大幅な短縮 etc.
 * - growth: 行数増 / 新セクション / ユーザ追記
 */

import { createHash } from "node:crypto";

export interface AnalysisResult {
  poison_score: number;
  poison_reasons: string[];
  growth_score: number;
  growth_notes: string[];
  size_bytes: number;
  line_count: number;
  section_count: number;
  content_hash: string;
}

export interface AnalysisInput {
  current: string;
  previous?: string;          // 直前 snapshot の content
  baseline?: string;          // /v1/setup が配信する公式 content
  expected_skill_name: string; // "concordia"
}

const DANGER_PATTERNS: Array<{ re: RegExp; weight: number; reason: string }> = [
  { re: /rm\s+-rf\s+\/(?!\w)/, weight: 0.8, reason: "rm -rf / pattern" },
  { re: /rm\s+-rf\s+~/, weight: 0.7, reason: "rm -rf ~ pattern" },
  { re: /:\(\)\{[^}]*\};:/, weight: 0.9, reason: "fork bomb pattern" },
  { re: /curl[^|\n]*\|\s*(?:sh|bash|zsh)/, weight: 0.8, reason: "curl | sh pipe" },
  { re: /wget[^|\n]*\|\s*(?:sh|bash|zsh)/, weight: 0.8, reason: "wget | sh pipe" },
  { re: /\beval\s*\(\s*\$/, weight: 0.5, reason: "eval($...) injection-prone" },
  { re: /(?:^|\W)(\.ssh\/id_(?:rsa|ed25519))/, weight: 0.7, reason: "SSH private key reference" },
  { re: /AKIA[0-9A-Z]{16}/, weight: 0.7, reason: "AWS access key id" },
  { re: /ghp_[A-Za-z0-9]{20,}/, weight: 0.7, reason: "GitHub token pattern" },
  { re: /sk-[A-Za-z0-9]{20,}/, weight: 0.6, reason: "API key pattern" },
  { re: /-i\s+\/etc\/(?:passwd|shadow)/, weight: 0.7, reason: "/etc/passwd|shadow access" },
  { re: /git\s+push\s+--force\b/, weight: 0.3, reason: "git push --force" },
  { re: /--no-verify\b/, weight: 0.3, reason: "skip pre-commit / signing" },
  // prompt-injection
  { re: /ignore\s+(?:previous|prior|all)\s+(?:instructions|rules)/i, weight: 0.9, reason: "prompt injection: ignore previous instructions" },
  { re: /you\s+are\s+now\s+(?:a|an)\s+/i, weight: 0.6, reason: "role-rewrite pattern" },
  { re: /system\s*:\s*you\s+(?:must|should)/i, weight: 0.6, reason: "fake system: prompt injection" },
  { re: /disregard\s+(?:safety|guardrails)/i, weight: 0.9, reason: "disregard safety pattern" },
];

const REQUIRED_SECTIONS_FOR_CONCORDIA = [
  "## hook 出力の読み方",
  "## task kind ごとの対応",
  "HUMAN_CONFIRMATION_REQUIRED",
];

export function analyze(input: AnalysisInput): AnalysisResult {
  const content = input.current;
  const lines = content.split(/\r?\n/);
  const line_count = lines.length;
  const size_bytes = Buffer.byteLength(content, "utf8");
  const section_count = lines.filter((l) => /^#{1,6}\s+\S/.test(l)).length;
  const content_hash = createHash("sha256").update(content).digest("hex");

  const poison_reasons: string[] = [];
  let poison_score = 0;

  // 1. 危険パターン
  for (const p of DANGER_PATTERNS) {
    if (p.re.test(content)) {
      poison_score += p.weight;
      poison_reasons.push(p.reason);
    }
  }

  // 2. frontmatter 整合性
  const fm = parseFrontmatter(content);
  if (input.expected_skill_name && fm.name && fm.name !== input.expected_skill_name) {
    poison_score += 0.6;
    poison_reasons.push(`skill name altered: ${input.expected_skill_name} → ${fm.name}`);
  }
  if (!fm.name) {
    poison_score += 0.3;
    poison_reasons.push("frontmatter `name` missing");
  }

  // 3. 重要セクション削除
  for (const required of REQUIRED_SECTIONS_FOR_CONCORDIA) {
    if (!content.includes(required)) {
      poison_score += 0.5;
      poison_reasons.push(`missing required text: "${required}"`);
    }
  }

  // 4. 大幅短縮
  if (input.previous) {
    const prevSize = Buffer.byteLength(input.previous, "utf8");
    if (prevSize > 0 && size_bytes < prevSize * 0.5) {
      poison_score += 0.3;
      poison_reasons.push(
        `size shrunk significantly (${prevSize}B → ${size_bytes}B = ${Math.round(
          (size_bytes / prevSize) * 100,
        )}%)`,
      );
    }
  }

  // 5. 公式 baseline からの極端な乖離
  if (input.baseline) {
    const baseSize = Buffer.byteLength(input.baseline, "utf8");
    const ratio = baseSize > 0 ? size_bytes / baseSize : 1;
    if (ratio < 0.4) {
      poison_score += 0.2;
      poison_reasons.push(`drift from baseline: ${Math.round(ratio * 100)}% of original`);
    }
  }

  // ─── growth ─────────────────────────────────────────
  const growth_notes: string[] = [];
  let growth_score = 0;

  if (input.previous) {
    const prev = input.previous;
    const prevLines = prev.split(/\r?\n/).length;
    const prevSections = (prev.match(/^#{1,6}\s+\S/gm) ?? []).length;
    const prevBytes = Buffer.byteLength(prev, "utf8");

    const lineDelta = line_count - prevLines;
    const sectionDelta = section_count - prevSections;
    const sizeDelta = size_bytes - prevBytes;

    if (sectionDelta > 0) {
      growth_score += Math.min(0.4, sectionDelta * 0.1);
      growth_notes.push(`+${sectionDelta} section(s)`);
    }
    if (lineDelta > 0) {
      growth_score += Math.min(0.3, lineDelta / 100);
      growth_notes.push(`+${lineDelta} line(s)`);
    }
    if (sizeDelta > 0) {
      growth_score += Math.min(0.3, sizeDelta / 4000);
      growth_notes.push(`+${sizeDelta} byte(s)`);
    }
    if (sizeDelta === 0 && lineDelta === 0 && sectionDelta === 0) {
      growth_notes.push("no change");
    }
  } else {
    growth_score = 0.2;
    growth_notes.push("initial snapshot");
  }

  // ── ユーザ追記検出 (frontmatter に標準外 key、 末尾 "## ノート" 等) ──
  const extraFrontmatterKeys = Object.keys(fm).filter(
    (k) => !["name", "description", "version"].includes(k),
  );
  if (extraFrontmatterKeys.length > 0) {
    growth_score += 0.1;
    growth_notes.push(`user annotations: ${extraFrontmatterKeys.join(", ")}`);
  }

  return {
    poison_score: Math.min(1, poison_score),
    poison_reasons,
    growth_score: Math.min(1, growth_score),
    growth_notes,
    size_bytes,
    line_count,
    section_count,
    content_hash,
  };
}

function parseFrontmatter(content: string): Record<string, string> {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w.-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}
