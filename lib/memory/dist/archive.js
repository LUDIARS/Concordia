/**
 * 退避 (archive) と復帰 (restore) の副作用層。
 *
 * 完全削除は **しない** (規約 req 6)。 block のファイルを兄弟 `_archive/` へ move し、
 * メモリなら MEMORY.md から該当 index 行を改行コードを保ったまま除去、 `_archive/ledger.jsonl`
 * (機械) と `_archive/ARCHIVE.md` (人間) に追記する。 退避ファイルは人間が読める
 * (= オールドファッションルールとして保存) が、 index / 自動ロード対象からは外れる。
 *
 * - planArchive: dry-run (fs 書き込みなし)。
 * - applyArchive: 実行。
 * - listArchived / restore: 台帳閲覧と復帰。
 *
 * `now` (epoch 秒) は注入式 (テスト決定性、 規約 §16)。
 */
import { existsSync, mkdirSync, renameSync, copyFileSync, rmSync, cpSync, statSync, readFileSync, writeFileSync, appendFileSync, readdirSync, } from "node:fs";
import { join, dirname, basename } from "node:path";
const LEDGER = "ledger.jsonl";
const HUMAN_LEDGER = "ARCHIVE.md";
/** dry-run: 何が起きるかを計算する (fs は変更しない)。 */
export function planArchive(targets) {
    return targets.map((t) => planOne(t));
}
function planOne(t) {
    const warnings = [];
    const willDeindex = !!(t.indexPath && t.indexLine);
    if (t.orphanIndex || !fileOrDirExists(t.absPath)) {
        // 移動するファイルが無い → index 行のみ除去。
        if (!willDeindex) {
            warnings.push("移動対象ファイルが無く、 除去できる index 行もありません。");
            return mkItem(t, "deindex-only", null, null, false, warnings, false);
        }
        return mkItem(t, "deindex-only", null, null, true, warnings, true);
    }
    const dest = join(t.archiveDir, basename(t.absPath));
    if (existsSync(dest)) {
        warnings.push(`退避先に同名 "${basename(t.absPath)}" が既に存在します。 手動で解決してください。`);
        return mkItem(t, willDeindex ? "move-and-deindex" : "move", t.absPath, dest, false, warnings, false);
    }
    return mkItem(t, willDeindex ? "move-and-deindex" : "move", t.absPath, dest, willDeindex, warnings, true);
}
/** 実行: move + de-index + 台帳追記。 dry-run で ok=false の item は skip する。 */
export function applyArchive(targets, now) {
    const items = [];
    for (const t of targets) {
        const plan = planOne(t);
        if (!plan.ok) {
            items.push(plan);
            continue;
        }
        try {
            ensureDir(t.archiveDir);
            let archivedAs = null;
            if (plan.action !== "deindex-only" && plan.to && plan.from) {
                movePath(plan.from, plan.to);
                archivedAs = basename(plan.to);
            }
            let indexLineRemoved = false;
            if (t.indexPath && t.indexLine && existsSync(t.indexPath)) {
                indexLineRemoved = removeIndexLineFromFile(t.indexPath, t);
            }
            appendLedger(t, now, archivedAs, indexLineRemoved);
            items.push({ ...plan, indexLineRemoved });
        }
        catch (e) {
            items.push({
                ...plan,
                ok: false,
                warnings: [...plan.warnings, `退避中にエラー: ${e.message}`],
            });
        }
    }
    return { applied: true, items };
}
/** 台帳 (ledger.jsonl) を読み、 現在退避中のエントリを新しい順で返す。 */
export function listArchived(archiveDir) {
    const ledgerPath = join(archiveDir, LEDGER);
    if (!existsSync(ledgerPath))
        return [];
    const out = [];
    for (const line of readFileSync(ledgerPath, "utf-8").split(/\r?\n/)) {
        const t = line.trim();
        if (!t)
            continue;
        try {
            out.push(JSON.parse(t));
        }
        catch {
            /* 壊れた行は無視 (best-effort、 台帳は append-only) */
        }
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
}
/** 退避を戻す。 archiveDir 配下の name に対応する台帳を引き、 ファイルを元位置へ move、
 *  memory なら index 行を MEMORY.md 末尾に再追記する。 */
export function restoreArchived(archiveDir, blockId, now) {
    const rootDir = dirname(archiveDir);
    const records = listArchived(archiveDir);
    const rec = records.find((r) => r.blockId === blockId);
    if (!rec) {
        return { ok: false, name: blockId, restoredTo: null, indexLineRestored: false, warnings: ["台帳に該当エントリがありません。"] };
    }
    const warnings = [];
    let restoredTo = null;
    if (rec.archivedAs) {
        const from = join(archiveDir, rec.archivedAs);
        const to = join(rootDir, rec.relPath);
        if (!fileOrDirExists(from)) {
            warnings.push(`退避ファイル "${rec.archivedAs}" が見つかりません。`);
        }
        else if (existsSync(to)) {
            warnings.push(`戻し先 "${rec.relPath}" に既にファイルがあります。 手動で解決してください。`);
        }
        else {
            movePath(from, to);
            restoredTo = to;
        }
    }
    let indexLineRestored = false;
    const indexPath = join(rootDir, "MEMORY.md");
    if (rec.kind === "memory" && rec.indexLine && existsSync(indexPath)) {
        appendIndexLine(indexPath, rec.indexLine);
        indexLineRestored = true;
    }
    // 台帳から当該レコードを除去 (ファイル移動が成功した時のみ)。
    if (restoredTo || !rec.archivedAs) {
        rewriteLedgerWithout(archiveDir, blockId);
        appendHumanLedger(archiveDir, `- [${iso(now)}] restored ${rec.name}`);
    }
    return { ok: warnings.length === 0, name: rec.name, restoredTo, indexLineRestored, warnings };
}
// ── 内部ヘルパ ──────────────────────────────────────────────
function mkItem(t, action, from, to, indexLineRemoved, warnings, ok) {
    return { blockId: t.blockId, name: t.name, action, from, to, indexLineRemoved, warnings, ok };
}
function fileOrDirExists(p) {
    try {
        statSync(p);
        return true;
    }
    catch {
        return false;
    }
}
function ensureDir(dir) {
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
}
/** rename を試し、 別デバイス (EXDEV) なら copy + 削除でフォールバック。 */
function movePath(from, to) {
    try {
        renameSync(from, to);
        return;
    }
    catch (e) {
        if (e.code !== "EXDEV")
            throw e;
    }
    const st = statSync(from);
    if (st.isDirectory()) {
        cpSync(from, to, { recursive: true });
        rmSync(from, { recursive: true, force: true });
    }
    else {
        copyFileSync(from, to);
        rmSync(from, { force: true });
    }
}
/**
 * MEMORY.md から indexLine (trim 一致) の物理行を 1 つ除去する。
 * 他行の改行コードは保つ (req: 改行コードを保ったまま)。
 */
export function removeIndexLine(raw, indexLine) {
    const target = indexLine.trim();
    if (!target)
        return { content: raw, removed: false };
    const segs = raw.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
    let removed = false;
    const kept = [];
    for (const seg of segs) {
        const text = seg.replace(/\r\n$|\r$|\n$/, "");
        if (!removed && text.trim() === target) {
            removed = true;
            continue;
        }
        kept.push(seg);
    }
    return { content: kept.join(""), removed };
}
/**
 * grouped 行 (1 行に複数リンク) から該当リンク `[title](file.md)` 1 つだけを除去する。
 * 該当物理行を indexLine(trim 一致) で特定し、 linkText + 隣接セパレータ (" / " か "/")
 * を 1 つ削る。 除去後にその行へリンクが残らなければ行ごと消す。 他行の改行コードは保つ。
 * 注: リンク直後の括弧注記 (例 "(正本RULE§7)") は残置する (まれな大原則行のみ該当)。
 */
export function removeIndexLink(raw, lineRaw, linkText) {
    const target = lineRaw.trim();
    if (!target || !linkText)
        return { content: raw, removed: false };
    const segs = raw.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
    let removed = false;
    const kept = [];
    for (const seg of segs) {
        const eol = seg.match(/\r\n$|\r$|\n$/)?.[0] ?? "";
        const text = seg.slice(0, seg.length - eol.length);
        if (!removed && text.trim() === target) {
            const idx = text.indexOf(linkText);
            if (idx < 0) {
                kept.push(seg);
                continue;
            }
            removed = true;
            let start = idx;
            let end = idx + linkText.length;
            const sepAfter = text.slice(end).match(/^\s*\/\s*/);
            if (sepAfter) {
                end += sepAfter[0].length;
            }
            else {
                const sepBefore = text.slice(0, start).match(/\s*\/\s*$/);
                if (sepBefore)
                    start -= sepBefore[0].length;
            }
            const next = (text.slice(0, start) + text.slice(end)).replace(/\s+$/, "");
            // リンクが残らなければ行ごと除去 (eol も落とす)。
            if (!/\[[^\]]+\]\([^)]+\)/.test(next))
                continue;
            kept.push(next + eol);
            continue;
        }
        kept.push(seg);
    }
    return { content: kept.join(""), removed };
}
function removeIndexLineFromFile(indexPath, t) {
    const raw = readFileSync(indexPath, "utf-8");
    const { content, removed } = t.indexLineSole === false && t.indexLinkText
        ? removeIndexLink(raw, t.indexLine ?? "", t.indexLinkText)
        : removeIndexLine(raw, t.indexLine ?? "");
    if (removed)
        writeFileSync(indexPath, content, "utf-8");
    return removed;
}
function appendIndexLine(indexPath, indexLine) {
    const raw = readFileSync(indexPath, "utf-8");
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const needsEol = raw.length > 0 && !/\r?\n$/.test(raw);
    appendFileSync(indexPath, `${needsEol ? eol : ""}${indexLine}${eol}`, "utf-8");
}
function appendLedger(t, now, archivedAs, indexLineRemoved) {
    const rec = {
        ts: now,
        blockId: t.blockId,
        name: t.name,
        kind: t.kind,
        relPath: t.relPath,
        archivedAs,
        indexLine: t.indexLine,
        reason: t.reason,
    };
    ensureDir(t.archiveDir);
    appendFileSync(join(t.archiveDir, LEDGER), JSON.stringify(rec) + "\n", "utf-8");
    const detail = archivedAs
        ? indexLineRemoved
            ? "file+index"
            : "file"
        : indexLineRemoved
            ? "index-line only"
            : "no-op";
    const human = `- [${iso(now)}] archived ${t.name} (${detail})`;
    appendHumanLedger(t.archiveDir, human);
}
function appendHumanLedger(archiveDir, line) {
    const p = join(archiveDir, HUMAN_LEDGER);
    if (!existsSync(p)) {
        writeFileSync(p, "# 退避済みルール/スキル (オールドファッション)\n\n" +
            "ここに移動したものは index / 自動ロード対象から外れるが、 ファイルは下に残っており読める。\n\n", "utf-8");
    }
    appendFileSync(p, line + "\n", "utf-8");
}
function rewriteLedgerWithout(archiveDir, blockId) {
    const ledgerPath = join(archiveDir, LEDGER);
    if (!existsSync(ledgerPath))
        return;
    const kept = [];
    for (const line of readFileSync(ledgerPath, "utf-8").split(/\r?\n/)) {
        const t = line.trim();
        if (!t)
            continue;
        try {
            const rec = JSON.parse(t);
            if (rec.blockId === blockId)
                continue;
        }
        catch {
            /* 壊れた行は保持 */
        }
        kept.push(line);
    }
    writeFileSync(ledgerPath, kept.length ? kept.join("\n") + "\n" : "", "utf-8");
}
function iso(now) {
    return new Date(now * 1000).toISOString();
}
/** archiveDir 配下の退避済みファイル名一覧 (台帳と突合せず生の中身を見る用)。 */
export function listArchiveFiles(archiveDir) {
    try {
        return readdirSync(archiveDir).filter((n) => n !== LEDGER && n !== HUMAN_LEDGER);
    }
    catch {
        return [];
    }
}
