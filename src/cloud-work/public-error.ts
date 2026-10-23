const PUBLIC_CLOUD_ERRORS: ReadonlySet<string> = new Set([
  "cloud_artifact_collection_failed", "cloud_artifact_integrity_failed", "cloud_artifact_not_found",
  "cloud_artifact_too_large", "cloud_artifact_transfer_unready", "cloud_artifact_unavailable",
  "cloud_attempt_conflict", "cloud_attempt_not_found", "cloud_batch_conflict",
  "cloud_batch_instruction_too_long", "cloud_batch_journal_incomplete", "cloud_batch_not_found",
  "cloud_batch_provider_unsupported", "cloud_batch_schedule_owner_required", "cloud_batch_variables_mismatch",
  "cloud_budget_exhausted", "cloud_company_capacity_exhausted", "cloud_configuration_invalid",
  "cloud_environment_mismatch", "cloud_git_access_binding_missing", "cloud_git_artifact_missing_or_not_regular",
  "cloud_git_artifact_too_large", "cloud_git_artifact_tree_invalid", "cloud_git_binding_missing",
  "cloud_git_branch_checked_out", "cloud_git_collection_unavailable", "cloud_git_repository_changed",
  "cloud_git_result_not_received", "cloud_git_review_unknown", "cloud_gpu_unverified",
  "cloud_journal_incomplete", "cloud_observation_head_office_only", "cloud_pending_human_question",
  "cloud_provider_mismatch", "cloud_published_source_unverified", "cloud_review_unavailable",
  "cloud_s3_transfer_not_selected", "cloud_source_unavailable", "cloud_storage_credentials_missing",
  "cloud_target_configuration_changed", "cloud_target_not_found", "cloud_target_not_ready",
  "cloud_task_not_active", "cloud_task_store_unavailable", "cloud_work_evidence_missing",
  "cloud_work_ineligible", "cloud_work_plan_required_or_invalid", "codex_cloud_access_unverified",
  "codex_cloud_observation_failed", "codex_cloud_process_failed", "invalid_claude_cloud_configuration",
  "invalid_cloud_artifact_entry", "invalid_cloud_artifact_manifest", "invalid_cloud_attempt_id",
  "invalid_cloud_batch_id", "invalid_cloud_object", "invalid_cloud_remote_id",
  "invalid_cloud_storage_configuration", "invalid_cloud_submission", "standard_hosted_required",
]);

/** Redacts arbitrary provider/SDK/transport text at public and persisted-status boundaries. */
export function publicCloudError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return PUBLIC_CLOUD_ERRORS.has(message) ? message : "cloud_operation_failed";
}
