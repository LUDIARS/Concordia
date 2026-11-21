import type { ColabJournal } from "./colab-journal.js";
import type { SiteColabRun } from "./colab-run.js";
import type { ColabSiteTransport } from "./colab-site-excubitor.js";
import { siteJobAction, siteJobEvidence } from "./colab-site-policy.js";
import type { SiteReceipt } from "./colab-site-schema.js";

export class ColabSiteRunner {
  constructor(private readonly journal: ColabJournal, readonly transport: ColabSiteTransport,
    private readonly leaseOwner: string, private readonly now: () => number) {}

  async advance(run: SiteColabRun, initial: boolean, refresh: boolean): Promise<void> {
    const { peerId, programId, gpu } = run.binding.site;
    const jobId = run.site.receipt?.id;
    const action = siteJobAction({ allocation: run.allocation, jobId,
      stopRequested: run.site.stopRequested && !refresh, cancelSent: run.site.cancelSent }, initial);
    if (action === "hold") {
      if (run.allocation === "unattempted") {
        run.stopReason = run.site.stopRequested ? "cancelled" : "interrupted";
        run.receipt = { state: "submission_refused", requestId: run.requestId };
        run.resourceRelease = "released";
      } else if (run.error === "cloud_colab_site_submission_unknown") {
        return;
      } else {
        run.error = "cloud_colab_site_submission_unknown";
      }
      this.save(run);
      return;
    }

    if (action === "submit") {
      if (this.now() >= run.deadlineAt) {
        run.providerTerminal = "failed";
        run.stopReason = "deadline";
        run.receipt = { state: "submission_refused", requestId: run.requestId };
        run.resourceRelease = "released";
        this.save(run);
        return;
      }
      run.allocation = "uncertain";
      this.save(run);
      try {
        const response = await this.transport.submit(peerId, { idempotencyKey: run.requestId, ownerId: run.binding.ownerId,
          ownerStart: true, programId, sourceRevision: run.sourceRevision, programSha256: run.binding.programSha256,
          gpu, deadlineAt: run.deadlineAt, code: "public", data: "non_confidential" });
        if ("refused" in response) {
          run.allocation = "refused";
          run.error = response.refused;
          run.receipt = { state: "submission_refused", requestId: run.requestId };
          run.providerTerminal = "failed";
          run.resourceRelease = "released";
        } else {
          this.record(run, response.receipt);
        }
      } catch { run.error = "cloud_colab_site_submission_unknown"; }
      this.save(run);
      return;
    }

    if (!jobId || (action === "observe" && run.error && !refresh)) return;
    if (action === "cancel") {
      run.site.cancelSent = true;
      this.save(run);
    }
    try {
      const receipt = await (action === "cancel" ? this.transport.cancel(peerId, jobId) : this.transport.observe(peerId, jobId));
      this.record(run, receipt);
    } catch {
      run.error = action === "cancel" ? "cloud_colab_site_stop_unconfirmed" : "cloud_colab_site_observation_unavailable";
    }
    this.save(run);
  }

  private save(run: SiteColabRun): void { this.journal.save(run, this.leaseOwner, this.now()); }

  private record(run: SiteColabRun, receipt: SiteReceipt): void {
    const { programId, gpu } = run.binding.site;
    if (receipt.programId !== programId || receipt.sourceRevision !== run.sourceRevision || receipt.gpu !== gpu
      || receipt.deadlineAt > run.deadlineAt || receipt.deadlineAt < receipt.createdAt
      || (run.site.receipt && receipt.id !== run.site.receipt.id)) throw new Error("cloud_colab_site_receipt_mismatch");
    run.site.receipt = receipt;
    run.receipt = { state: "submitted", requestId: run.requestId, remoteId: receipt.id };
    const evidence = siteJobEvidence(receipt, run.site.stopRequested);
    run.providerTerminal = evidence.providerTerminal;
    run.resourceRelease = evidence.resourceRelease;
    run.stopReason = receipt.stopReason;
    run.error = null;
  }
}
