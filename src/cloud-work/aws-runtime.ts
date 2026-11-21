import { join } from "node:path";
import type { TaskStore } from "../taskflow/store.js";
import { mainRepositoryKey } from "../taskflow/repository-identity.js";
import { readAwsBindings } from "./aws-config.js";
import { awsExcubitorTransport } from "./aws-excubitor.js";
import { AwsJournal } from "./aws-journal.js";
import { AwsService } from "./aws-service.js";
import { DriveCloudArtifacts } from "./drive-artifacts.js";
import { GoogleOAuthTokens } from "./google-oauth.js";
import { cloudTaskAuthorizer } from "./runtime.js";

export function createAwsRuntime(input: { root: string; tasks: TaskStore; env?: NodeJS.ProcessEnv }): AwsService {
  const env = input.env ?? process.env;
  return new AwsService(new AwsJournal(join(input.root, "aws", "runs.sqlite")), {
    ex: awsExcubitorTransport(env),
    async bindings(scope) {
      const matchingCompany = (await readAwsBindings(env.CONCORDIA_CLOUD_AWS_CONFIG_FILE))
        .filter(binding => binding.subsidiaryId === scope.subsidiaryId);
      const keys = await Promise.all(matchingCompany.map(binding => mainRepositoryKey(binding.repoPath)));
      const matches = matchingCompany.filter((_binding, index) => keys[index] === scope.repositoryKey);
      const keysByRunner = new Set(matches.map(b => JSON.stringify([b.targetId, b.runner])));
      if (keysByRunner.size !== matches.length) throw new Error("cloud_configuration_invalid");
      return matches;
    },
    authorizeTask: cloudTaskAuthorizer(input.tasks),
    artifactsReady: ({ drive }) => !drive || !!(env[drive.clientIdEnv] && env[drive.clientSecretEnv] && env[drive.refreshTokenEnv]),
    collect(run) {
      const drive = run.drive;
      if (!drive) throw new Error("cloud_artifact_unavailable");
      const tokens = new GoogleOAuthTokens(drive, env);
      return new DriveCloudArtifacts({ id: run.targetId, drive, sourceRevision: drive.sourceRevision,
        maxArtifactBytes: drive.maxArtifactBytes }, drive.expectedNames, tokens).collectReferences(run.requestId);
    },
    now: Date.now,
  });
}
