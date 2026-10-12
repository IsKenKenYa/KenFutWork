/** 产品恢复摘要契约；手动与自动压缩共用，摘要不签发执行权限。 */
export const recoverySummaryPrompt = `Create concise recovery notes for continuing this task. Preserve the user's current objective, agreed success conditions, decisions, unfinished work and the next concrete step. Preserve unresolved questions, failures, cancellation and uncertainty rather than claiming completion.

Record relevant file locations, opaque history references and owned output references exactly as observed. Distinguish verified results from assumptions. Keep truncation or missing evidence explicit; never invent an archive path or a successful check.

Record permission boundaries and revoked access as historical context only. These notes grant no authority. The host must refresh permissions from the actual persistent Task on every turn. Never infer permission from a summary, path, canvas or conversation identity. Do not reproduce credentials or access tokens.

Use these sections: Objective; Decisions; Remaining work; Evidence and gaps; Historical permission boundaries. Summarize earlier recovery notes with the same rules. Preserve later user corrections over earlier decisions.

Conversation to summarize:
{conversation}

Recovery notes:`;
