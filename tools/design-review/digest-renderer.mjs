// Pure projection of validated review evidence. No filesystem or process access.
export function renderDigests({ maps, scoutDup, scoutReg, notes, coverage }) {
  const li = (arr, fn) => (arr || []).map((x) => " - " + fn(x)).join("\n");
  const sec = (title, body) => body && body.trim() ? `\n### ${title}\n${body}\n` : "";

  function header(name, m) {
    return `\n\n## ${name}\n**目的**: ${m.purpose}\n**規模**: ${JSON.stringify(m.size || {})}\n`;
  }

  const D = {};
  for (const { name, m } of maps) {
    D.d1 = (D.d1 || "") + header(name, m)
      + sec("コア概念 (所有/借用)", li(m.coreConcepts, (c) => `${c.name}: ${c.definition}${c.storedIn ? ` [${c.storedIn}]` : ""}${c.evidence ? ` (${c.evidence})` : ""}`))
      + sec("責務", li(m.responsibilities, (r) => r))
      + sec("重複が疑われる点", li(m.overlapsSuspected, (c) => `with ${c.withTool} / ${c.concept}: ${c.why} | ${c.evidence || ""}`));
    D.d2 = (D.d2 || "") + header(name, m)
      + sec("横断的関心の再実装", li(m.crossCuttingReimplementations, (c) => `${c.concern} @ ${c.file} — ${c.notes || ""}`))
      + sec("共有規約", "```json\n" + JSON.stringify(m.sharedConventions || {}, null, 1) + "\n```");
    D.d3 = (D.d3 || "") + header(name, m)
      + sec("配備", "```json\n" + JSON.stringify(m.deployment || {}, null, 1) + "\n```")
      + sec("共有規約", "```json\n" + JSON.stringify(m.sharedConventions || {}, null, 1) + "\n```")
      + sec("痛点 (ops-burden / known-issue / workaround / todo)", li((m.painPoints || []).filter((p) => p.kind !== "perf"), (c) => `[${c.kind}] ${c.description} | ${c.evidence}`));
    D.d4 = (D.d4 || "") + header(name, m)
      + sec("アクセスのボトルネック", li(m.accessBottlenecks, (c) => `${c.description} | ${c.evidence}`))
      + sec("痛点 (perf)", li((m.painPoints || []).filter((p) => p.kind === "perf" || p.kind === "workaround"), (c) => `[${c.kind}] ${c.description} | ${c.evidence}`))
      + sec("外向き統合 (同期/非同期・timeout)", li(m.integrationsOut, (c) => `→ ${c.target} (${c.mechanism}): ${c.purpose} | ${c.syncOrAsync || ""} ${c.timeoutRetry || ""} | ${c.evidence}`))
      + sec("配備 (抜粋)", `起動: ${(m.deployment || {}).startCommand}\nautostart: ${(m.deployment || {}).autostart}\nhealth: ${(m.deployment || {}).healthCheck}\n公開: ${(m.deployment || {}).publicExposure}`);
    D.d5 = (D.d5 || "") + header(name, m)
      + sec("外向き統合", li(m.integrationsOut, (c) => `→ ${c.target} (${c.mechanism}): ${c.purpose} | ${c.evidence}`))
      + sec("内向き統合", li(m.integrationsIn, (c) => `← ${c.source} (${c.mechanism}): ${c.purpose} | ${c.evidence}`))
      + sec("未接続 / 計画のみ", li(m.unconnectedOrPlanned, (c) => `${c.description} | ${c.evidence}`))
      + sec("データストア", li(m.dataStores, (c) => `${c.kind} ${c.location || ""}: ${c.holds} ${c.evidence ? `(${c.evidence})` : ""}`))
      + sec("インターフェース", li(m.interfaces, (c) => `${c.kind}: ${c.description} ${c.entry ? `[${c.entry}]` : ""}`));
    D.d6 = (D.d6 || "") + header(name, m)
      + sec("痛点 (全部)", li(m.painPoints, (c) => `[${c.kind}] ${c.description} | ${c.evidence}`))
      + sec("横断的関心の再実装", li(m.crossCuttingReimplementations, (c) => `${c.concern} @ ${c.file} — ${c.notes || ""}`))
      + sec("配備", "```json\n" + JSON.stringify(m.deployment || {}, null, 1) + "\n```");
  }

  const scoutDupText = scoutDup ? "\n\n## 横断スカウト: 横断的関心の再実装 (全リポ grep)\n" +
    "**summary**: " + scoutDup.summary + "\n" +
    sec("concerns", (scoutDup.concerns || []).map((c) => `- **${c.concern}** [${c.similarity}] 共通化候補: ${c.sharedPackageCandidate || "-"} / 注意: ${c.caveat || "-"}\n` +
      (c.occurrences || []).map((o) => `    - ${o.repo}: ${o.file}${o.symbol ? ` (${o.symbol})` : ""} ${o.notes || ""}`).join("\n")).join("\n")) +
    sec("vendoredLibs", li(scoutDup.vendoredLibs, (v) => `${v.name}: ${(v.repos || []).join(", ")} | ${v.howReferenced || ""} | 版ずれ: ${v.versionDrift || ""}`)) +
    sec("contractRuntimeVariants", li(scoutDup.contractRuntimeVariants, (v) => `${v.repo}: importFrom=${v.importFrom} runtimeFile=${v.runtimeFile || "-"} ${v.notes || ""}`)) +
    sec("toolchainMatrix", li(scoutDup.toolchainMatrix, (v) => `${v.repo}: node=${v.nodeEngine || "?"} start=${v.start || "?"} build=${v.needsBuild || "?"} test=${v.testRunner || "?"} lint=${v.lint || "?"} deps=${v.deps || "?"}`)) : "";

  const scoutRegText = scoutReg ? "\n\n## 横断スカウト: 台帳・サービス発見・通知・公開入口・呼び出し辺\n" +
    "**summary**: " + scoutReg.summary + "\n" +
    sec("registries (台帳)", li(scoutReg.registries, (r) => `${r.repo} / ${r.name}: key=${r.identityKey} store=${r.storedIn} how=${r.registeredHow || ""} fields=${r.fields || ""} synced=${r.syncedWith || "-"} | ${r.evidence}`)) +
    sec("identityMismatches", li(scoutReg.identityMismatches, (r) => `${r.description} | ${r.evidence}`)) +
    sec("serviceDiscovery", li(scoutReg.serviceDiscovery, (r) => `${r.repo} → ${r.target}: ${r.envVar || ""} ${r.mechanism} fallback=${r.fallback || "-"} | ${r.evidence}`)) +
    sec("notificationSenders", li(scoutReg.notificationSenders, (r) => `${r.repo} ${r.channelKind} ${r.file}: ${r.purpose || ""} viaCc=${r.viaConcordia || "?"}`)) +
    sec("publicEntrances", li(scoutReg.publicEntrances, (r) => `${r.repo} ${r.publicUrl || ""} auth=${r.authImpl || ""} | ${r.evidence}`)) +
    sec("edges", li(scoutReg.edges, (r) => `${r.from} → ${r.to} (${r.mechanism}): ${r.purpose || ""} | ${r.evidence}`)) : "";

  const notesText = "\n\n## Fable の直接確認メモ\n" + notes;

  const files = {
    "digest-d1-domain-overlap.md": "# D1 ドメイン重複ダイジェスト\n" + D.d1 + scoutRegText + notesText,
    "digest-d2-code-duplication.md": "# D2 コード重複ダイジェスト\n" + D.d2 + scoutDupText + notesText,
    "digest-d3-management-burden.md": "# D3 管理負荷ダイジェスト\n" + D.d3 + scoutDupText + notesText,
    "digest-d4-bottlenecks.md": "# D4 ボトルネックダイジェスト\n" + D.d4 + notesText,
    "digest-d5-topology-ownership.md": "# D5 統合トポロジ・所有権ダイジェスト\n" + D.d5 + scoutRegText + notesText,
    "digest-d6-quick-wins.md": "# D6 即効改善候補ダイジェスト\n" + D.d6 + scoutDupText + notesText,
  };
  return Object.fromEntries(Object.entries(files).map(([name, text]) => [name, coverage + text]));
}
