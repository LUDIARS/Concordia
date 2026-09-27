/** Editable prose defaults only. Mode selection and API facts remain in workflow builders. */
export const ESCALATION_RETAINED_RULES: readonly string[] = [
  "Do not push directly to GitHub, and do not create or merge a GitHub PR. The escalation only relaxes local workflow, not the remote.",
  "A security scan that produced a real finding still stops the work, including under a bypass merge.",
  "Do not discard another session's changes and do not roll back a shared checkout. Escalation is a stop for others, never a rewind.",
];

export const ESCALATION_RELAXED_RULES: readonly string[] = [
  "Task registration (task_update) is not required while escalated. Ignore the harness work-registration gate.",
  "A task-specific worktree is not required. You may operate the working branch directly to restore service.",
  "Revisor CLI bypass merge may be used to land the fix while the daemon is down.",
  "You may continue past PR creation until the service is verified working again.",
];

export const NORMAL_WORKFLOW_RULES = [
      "人間の指示を対応する Actio task に紐づけ、Cc の task-links に参照を登録する。進捗の正本は Actio の task status。",
      "Cc の task_update は session 内の補助 todo 記録に使える。Actio task の実状態や人間の開始指示を置き換えない。",
      "Identify the individual project first. Workspace/Castra root is available for cross-project investigation; edit individual projects in their own checkout.",
      "Confirm the requested branch against the actual checkout and register that branch in Cc before editing; do not work directly on main.",
      "Commit your changes when the assigned work reaches a checkpoint or is complete — never leave the working tree uncommitted (this is mandatory; Codex sessions frequently forget to commit).",
      "When implementation is complete, follow the project workflow identified by Cc in the startup policy. Do not infer permission to push or choose a PR submission route when the workflow is unknown.",
      "タスクは Actio で参照してください。PR タイトル・本文は変更内容と検証範囲を日本語で記録し、タスク本文や機密情報を自動転記しないでください。",
      "Do not spawn subagents yourself (Agent/Task tool). Delegate parallel or split work through Concordia delegation (POST /v1/delegation/invoke) so the child gets its own surface, status card, and PR — unless the user explicitly asked for an in-session agent.",
      "Do not run any test unless the user explicitly requested it for this Session.",
      "Do not merge, enable auto-merge, or update main unless the user explicitly requested it.",
      "Goal & Go: 承認済みの残作業を継続し、止まったら別の進行可能な作業を進める。マージまで許可された依頼では、PR 提出や Test OK で止めず、PR の指摘修正・再審査・マージ・反映確認まで同じ loop で対応する。予定 task 一覧に進行中を GO と表示する。進められなければ人間判断の要点をまとめ human-wait に記録し、自動確認を停止する。結果不明の再送や審査ゲート回避をせず、明示された人間判断待ちは維持する。",
    ];

export const NORMAL_INTERRUPT_POLICY = "If the user interrupts with additional work, append it after the current queue unless the user explicitly marks it as priority.";
export const NORMAL_COMPLETION_POLICY = [
  "The default Session completion boundary is commit and PR submission through the workflow identified by Cc for the target project.",
  "When the human has authorized merge and reflection, continue through PR review fixes, re-review, merge and reflection confirmation; PR creation or Test OK alone does not complete that loop. Never repeat a submission or merge with an unknown result or bypass a review gate.",
  "Tests, service operations and merge still require authorization in the human instruction. If a decision blocks all remaining work, summarize it and enter human-wait; do not repeat automatic confirmation.",
  "After each loop list planned tasks, mark work in progress GO, and identify unresolved decisions.",
];

export const ESCALATION_WORKFLOW_RULES = [
      "ESCALATION MODE is active for this session (reason: [[CC:reason]]).",
      "Restoring a working service comes first. The relaxations below exist only for the duration of the outage.",
      ...ESCALATION_RELAXED_RULES,
      ...ESCALATION_RETAINED_RULES,
      'Release the mode as soon as the outage is over: [[CC:release_endpoint]] { "note": "..." }.',
      "Record what you bypassed. The escalation event is the audit trail the follow-up review reads.",
    ];
export const ESCALATION_INTERRUPT_POLICY = "Restoration work takes priority over queued requests. Other sessions have been asked to stop until this escalation is released.";
export const ESCALATION_COMPLETION_POLICY = [
  "The completion boundary is a working service, not PR creation.",
  "After the service is verified working, release the escalation and report what was bypassed.",
  "Follow-up review of bypassed merges happens after release (revisor pr bypassed / bypass-reviewed).",
];
