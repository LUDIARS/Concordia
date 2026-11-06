export default {
  post(result: unknown): boolean {
    return typeof result === "string" && ["概算%", "根拠", "未確認", "100%", "完了条件", "通知", "終端status", "依頼者", "人間", "予算",
      "skills/session-followup/SKILL.md", "```cc-progress", '"percent":', '"evidence":', '"remaining":', '"complete":', '"at":',
      "$LICTOR_PORT/v1/concordia/session", "GET /v1/sessions/:id", "session.current_task", "完全一致", "UTC ISO", "ブロックを省略",
    ].every((word) => result.includes(word));
  },
};
