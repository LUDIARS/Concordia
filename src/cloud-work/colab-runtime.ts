import { join } from "node:path";
import { z } from "zod";
import type { SettingsStore } from "../admin/settings-store.js";
import type { TaskStore } from "../taskflow/store.js";
import { cloudTaskAuthorizer } from "./runtime.js";
import type { CloudWorkRuntime } from "./runtime-service.js";
import { ColabService } from "./colab-service.js";
import { ColabJournal } from "./colab-journal.js";
import { readRegisteredColabProgram } from "./colab-program.js";
import { GoogleOAuthTokens, GOOGLE_COLAB_SCOPE, type GoogleOAuthCredential } from "./google-oauth.js";
import { DriveCloudArtifacts } from "./drive-artifacts.js";
import { ColabAdapter } from "./colab-adapter.js";
import { GoogleColabRest } from "./colab-rest.js";
import { HttpColabJupyter } from "./colab-jupyter.js";
import { requestFingerprint } from "./execution-adapter.js";

const Credential = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1), refreshToken: z.string().min(1) }).strict();

export interface ColabCredentialKey {
  ownerId: string;
  organizationId: string;
  ref: string;
  purpose: "colab" | "drive";
}

/** Excubitor's Vault integration can resolve this same owner/use binding. No CLI cache or env lookups. */
export interface ColabCredentials { get(key: ColabCredentialKey): GoogleOAuthCredential | null }

export function settingsColabCredentials(store: Pick<SettingsStore, "get">): ColabCredentials {
  return {
    get(key) {
      try {
        const hash = requestFingerprint([key.organizationId, key.ownerId, key.purpose, key.ref]);
        const raw = store.get(`cloud_work.oauth.${hash}`);
        return raw ? Credential.parse(JSON.parse(raw)) : null;
      } catch { return null; }
    },
  };
}

export function createColabRuntime(input: {
  root: string; tasks: TaskStore; runtime: CloudWorkRuntime; credentials: ColabCredentials;
  fetcher?: typeof fetch;
}): ColabService {
  const credentials = (binding: ColabCredentialKey) => {
    const value = input.credentials.get(binding);
    if (!value) throw new Error("cloud_colab_credentials_unavailable");
    return value;
  };
  const jupyter = new HttpColabJupyter(input.fetcher);
  return new ColabService(new ColabJournal(join(input.root, "colab")), {
    targets: scope => input.runtime.targets(scope),
    authorizeTask: cloudTaskAuthorizer(input.tasks),
    readProgram: readRegisteredColabProgram,
    bindingReady: binding => !!input.credentials.get({ ...binding, ref: binding.credentialRef, purpose: "colab" })
      && (!binding.drive || !!input.credentials.get({ ...binding, ref: binding.drive.credentialRef, purpose: "drive" })),
    adapter(run, allocation, signal) {
      const token = new GoogleOAuthTokens(credentials({ ...run.binding, ref: run.binding.credentialRef, purpose: "colab" }),
        {}, input.fetcher, Date.now, GOOGLE_COLAB_SCOPE);
      return new ColabAdapter(new GoogleColabRest(token, input.fetcher), jupyter, { allocation,
        attemptId: run.attemptId, revision: run.sourceRevision, checkpoints: run.binding.drive?.checkpointNames ?? [] }, signal);
    },
    drive(run) {
      const drive = run.binding.drive;
      if (!drive) return undefined;
      const token = new GoogleOAuthTokens(credentials({ ...run.binding, ref: drive.credentialRef, purpose: "drive" }),
        {}, input.fetcher, Date.now, "https://www.googleapis.com/auth/drive.file");
      return new DriveCloudArtifacts({ id: run.targetId, sourceRevision: run.sourceRevision, maxArtifactBytes: 32_000, drive },
        drive.checkpointNames, token, input.fetcher);
    },
    now: Date.now,
  });
}
