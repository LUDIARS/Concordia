# Project work actions (CC-WORK-ACTIONS-01)

UX-CC-W1/W2/W3, scenarios S1/S2/S4. A project owner chooses how chat requests reach their task tracker and where specification proposals are kept. Cc owns dispatch and delivery receipts. Notion owns the task and proposal. Actio is not on this path.

An operator points CC_PROJECT_WORK_ACTIONS at a trusted UTF-8 JSON file. Br can read the same configuration. Tokens live only in the Cc environment. Each repository has separate action bindings, selected Discord channels and an optional text prefix for mixed-use channels. Dedicated channels may use an empty prefix. Screen specifications are outside scope. Configure only channels intended for forwarding. Existing projects opt in individually.

    [{"repository":"owner/example","base":"main","bindings":[
      {"action":"task","discordRoles":["111"],"minimumRole":"staff","guild":"123","channel":"456","prefix":"依頼","dataSource":"00000000-0000-4000-8000-000000000001","initial":"未着手","done":"完了"},
      {"action":"proposal","discordRoles":["111"],"minimumRole":"staff","guild":"123","channel":"789","prefix":"","dataSource":"00000000-0000-4000-8000-000000000002","initial":"提案"}
    ]}]

Provide CC_NOTION_TOKEN_OWNER_EXAMPLE for this repository. Each Notion data source needs Name (title), Source (URL), Request (rich text), and Status (status including the configured names). For tasks completed by PR, use a branch ending in /cc-task-<Discord message ID> on the configured repository. Omit done for work requiring human acceptance. The merge must target the configured base. GitHub requires the signed webhook, Revisor uses its own merge result.

CC-WA-I1. Only uniquely routed human messages produce a write. Repeated deliveries and edits update the source-linked page without resetting its status. An exclusive local receipt reserves each creation before sending it. If delivery is uncertain, look up the source in Notion before recovery. If no page is visible, the operator must verify non-creation before clearing the receipt alongside the configuration file.

CC-WA-I2. Only a merged PR with the matching repository, base and work branch may complete its linked implementation task. Unlinked work, proposals and human acceptance stay independent. Disable a binding to stop new operations. Preserve receipts and external pages on rollback.

CC-WA-I3. Every Discord write requires a fresh guild member lookup, an explicitly permitted Discord role ID, and a Cc employee roster entry meeting the configured minimum role. Never accept role labels or actor IDs from message text. Failed lookup has no write effect. An authorized merge fact acts on behalf of the project. It does not grant login or merge authority to a Discord poster.
