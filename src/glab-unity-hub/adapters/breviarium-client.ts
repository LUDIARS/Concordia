/**
 * Breviarium の読み取り API (契約 v1 §2 `breviarium.snapshot`)。
 *
 * Breviarium の画面と同じ内容を返すため、 応答は加工せずそのまま渡す。
 * - project 指定あり: `GET /api/projects/:code/overview`
 * - 指定なし: `GET /api/projects`
 *
 * @implements spec/feature/glab-unity-hub.md §2 (GUH-BREVIARIUM)
 */

import type { BreviariumPort } from "../application/ports.js";
import type { LoopbackServiceHttp } from "./service-http.js";

export class BreviariumClient implements BreviariumPort {
  constructor(private readonly http: Pick<LoopbackServiceHttp, "request">) {}

  listProjects(): Promise<unknown> {
    return this.http.request("breviarium", "GET", "/api/projects");
  }

  projectOverview(project: string): Promise<unknown> {
    return this.http.request("breviarium", "GET", `/api/projects/${encodeURIComponent(project)}/overview`);
  }
}
