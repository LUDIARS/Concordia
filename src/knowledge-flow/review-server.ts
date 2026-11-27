import { createServer } from "node:http";
import type { Database } from "better-sqlite3";
import { decide, renderReport, type Report } from "./article-ledger.js";
function html(text: unknown) { return String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }
const origin = "http://127.0.0.1:8787";
const styles = "body{margin:0;background:#f5f4ef;color:#202725;font:16px/1.6 system-ui,sans-serif}main{max-width:76ch;padding:24px;margin:auto}article{background:white;border:1px solid #d8ddd8;padding:20px;margin:16px 0;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}p{overflow-wrap:anywhere}form{display:inline-block;margin:4px}button,a{padding:6px 12px}button{font:inherit;cursor:pointer}a{color:#175b50}";
export function reviewServer(db: Database) {
    return createServer((req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (req.headers.host !== "127.0.0.1:8787") {
            res.writeHead(403).end();
            return;
        }
        try {
            const path = new URL(req.url ?? "/", origin).pathname;
            if (req.method === "POST") {
                if (req.headers.origin !== origin) {
                    res.writeHead(403).end();
                    return;
                }
                const action = /^\/article\/(\d+)\/(adopt|skip|skill|retry)$/.exec(path);
                if (action)
                    decide(db, Number(action[1]), action[2]);
                else if (/^\/delivery\/\d+\/retry$/.test(path))
                    db.prepare("UPDATE knowledge_flow_notifications SET state='pending',retry_after=0 WHERE rowid=? AND state='failed'").run(Number(path.split("/")[2]));
                else {
                    res.writeHead(404).end();
                    return;
                }
                res.writeHead(303, { Location: "/" }).end();
                return;
            }
            if (req.method !== "GET") {
                res.writeHead(405).end();
                return;
            }
            const file = /^\/article\/(\d+)\/(knowledge|procedure|skill)\.md$/.exec(path);
            if (file) {
                const d = db.prepare("SELECT markdown AS document FROM knowledge_flow_documents WHERE article_id=? AND kind=?").get(Number(file[1]), file[2]) as {
                    document: string;
                } | undefined;
                if (!d) {
                    res.writeHead(404).end();
                    return;
                }
                res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="article-${file[1]}.md"` }).end(d.document);
                return;
            }
            if (path !== "/") {
                res.writeHead(404).end();
                return;
            }
            const rows = db.prepare(`SELECT a.id,a.url,a.state,j.report,j.page,j.error,d.action FROM knowledge_flow_articles a LEFT JOIN knowledge_flow_jobs j ON j.article_id=a.id
        LEFT JOIN knowledge_flow_decisions d ON d.article_id=a.id ORDER BY a.id DESC`).all() as {
                id: number;
                url: string;
                state: string;
                report: string | null;
                page: string | null;
                error: string | null;
                action: string | null;
            }[];
            const categories = new Map<string, {
                total: number;
                adopted: number;
            }>();
            const articles = rows.map(row => {
                const report = row.report ? JSON.parse(row.report) as Report : null;
                const adopted = ["adopt", "skill"].includes(row.action ?? "");
                if (report) {
                    const category = report.evaluation.category;
                    const count = categories.get(category) ?? { total: 0, adopted: 0 };
                    count.total++;
                    if (adopted)
                        count.adopted++;
                    categories.set(category, count);
                }
                const button = (action: string, label: string) => `<form method="post" action="/article/${row.id}/${action}"><button>${label}</button></form>`;
                const title = row.page ? (JSON.parse(row.page) as {
                    title: string;
                }).title : row.url;
                const controls = [];
                if (row.state === "review") {
                    if (report?.evaluation.verdict === "採用候補") {
                        controls.push(button("adopt", "採用"));
                        if (report.evaluation.technical)
                            controls.push(button("skill", "AIスキルも採用"));
                    }
                    controls.push(button("skip", "見送り"));
                }
                if (["review", "blocked"].includes(row.state))
                    controls.push(button("retry", "再分析"));
                if (adopted)
                    for (const [kind, label] of [["knowledge", "ナレッジ"], ...(report?.evaluation.technical ? [["procedure", "手順書"]] : []), ...(row.action === "skill" ? [["skill", "AIスキル"]] : [])])
                        controls.push(`<a href="/article/${row.id}/${kind}.md">${label}を保存</a>`);
                return `<article><h2>#${row.id} ${html(title)}</h2><p>${html(row.url)} · ${html(row.state)} ${html(row.error)}</p><pre>${html(report ? renderReport(row.id, title, report) : "")}</pre>${controls.join("")}</article>`;
            });
            const deliveries = db.prepare("SELECT rowid AS seq,state FROM knowledge_flow_notifications WHERE state IN ('unknown','failed','sending')").all() as {
                seq: number;
                state: string;
            }[];
            const delivery = deliveries.map(d => `<p>通知 #${d.seq} · ${html(d.state)}</p>` + (d.state === "failed" ? `<form method="post" action="/delivery/${d.seq}/retry"><button>再送</button></form>` : "")).join("");
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>記事レビュー</title><style>${styles}</style><main><h1>記事レビュー</h1>${[...categories].map(([c, n]) => html(c) + ": " + n.total + "件（採用 " + n.adopted + "件）").join(" / ")}${delivery}${articles.join("") || "<p>受付済みの記事はありません。</p>"}</main></html>`);
        }
        catch {
            res.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" }).end("記事の状態を確認してください");
        }
    });
}
