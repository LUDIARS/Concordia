# Taskflow Workspace Root Collided with Child Repo Name

- Date: 2026-08-31
- Status: fixed in working tree
- Area: taskflow project selection / Kaizen diagnosis
- Severity: high — a Parttimer session received a task owned by a different repository and produced a false incident diagnosis

## Summary

A Kaizen run claimed that a repository-relative task document did not exist. That claim was false: the untracked task exists in the child repository, and Concordia taskflow state marks it as pending for that repository.

## Evidence

- The collision was between a workspace root and its same-named child repository; both reduce to the same basename under case-insensitive matching.
- The Parttimer session initially had the workspace root as `repo_path`.
- Goal-and-Go injected the task before the session's later explicit project claim.
- The session's `repo_path` subsequently changed to the intended repository, but `current_task` retained the child-repository task selected during the initial binding.
- `src/taskflow/md-store.ts::findForProject()` reduced every selector to its basename before matching either frontmatter project or repo basename.

## Regression Context

Taskflow accepted both project identifiers and filesystem paths through one API, but did not preserve the semantic difference between them. A workspace whose name matches a child repository therefore selected that child's pending task.

## Cause

`TaskMdStore.findForProject()` treated path-like selectors as project names. Passing the workspace root produced the same basename as its child repository and selected that child's task. The later explicit Concordia claim updated session ownership fields but did not replace the already selected `current_task`. Kaizen then verified the repo-relative path against the wrong working directory and misreported it as missing.

## Fix Requirements

- Treat an absolute Windows or POSIX selector as a repository path and match only the normalized full `TaskDocument.repoPath`; keep owner/repo-style slugs in identifier mode.
- Keep case, separator style, and trailing separator normalization safe.
- Preserve frontmatter-project and repo-basename matching for plain project identifiers.
- Require Kaizen to resolve a repo-relative task path's owning repository from taskflow state and workspace main clones before declaring it missing or stale.
- Require Kaizen to compare `repo_path` / `target_project` transition timing with task injection timing before attributing session ownership failures.

## Verification

- A path selector for workspace root `...\Ars` must not select a task from child repo `...\Ars\ars`.
- The exact child repo path, including a trailing alternate separator, must select the task.
- Plain project identifier `ars` must retain the existing project-name behavior.
- Owner/repo identifier `LUDIARS/ars` must retain basename-based identifier behavior rather than being treated as an absolute path.
- Seed coverage must assert the owning-repo and session-transition instructions remain present.
- Tests were added but not run, per the task constraint.

## Follow-up

The untracked task in the child repository was not modified. Runtime rollout and verification remain for the normal reviewed deployment path.
