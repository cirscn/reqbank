const DIRECT_GIT_PROMPT_PATTERN = /^(?:(?:帮我|请|麻烦)?\s*(?:直接)?\s*提交(?:一下|下)?(?:本次|当前)?(?:代码|改动|更改)?|直接提交|commit|git commit|push)(?:[？?。！!])?$/i;
const GIT_PROCESS_FEEDBACK_PATTERN = /(?:提交|commit|push)[\s\S]*(?:为什么|为何|不应|不该|不要|不用|无需|流程|本末倒置)[\s\S]*(?:浏览器|验证|测试|dev server)|(?:浏览器|验证|测试|dev server)[\s\S]*(?:不应|不该|不要|不用|无需)[\s\S]*(?:提交|commit|push)|本末倒置/i;
export const HARNESS_META_PATTERN = /harness|\.agentdoc\/harness|AGENTS\.md|\.codex\/hooks|codex hooks?|harness hooks?|SessionStart|UserPromptSubmit|PostToolUse|Stop|召回|门禁|critic|learning-log|doctor/i;

export const classifyPromptKind = (prompt) => {
  const text = String(prompt ?? '');
  const trimmed = text.trim();
  if (/provide a short title for a task/i.test(text)) {
    return 'title_generation';
  }
  if (/code review guidelines|review findings|acting as a reviewer|# Review findings/i.test(text)) {
    return 'review';
  }
  if (HARNESS_META_PATTERN.test(text)) {
    return 'harness_meta';
  }
  if (DIRECT_GIT_PROMPT_PATTERN.test(trimmed)) {
    return 'git';
  }
  if (GIT_PROCESS_FEEDBACK_PATTERN.test(text)) {
    return 'process_feedback';
  }
  if (/修复|修改|实现|新增|删除|调整|改一下|fix|implement|add|remove|update/i.test(text)) {
    return 'implementation';
  }
  if (/允许.*验证|请验证|帮我验证|跑.*验证|打开.*页面|https?:\/\/|localhost|127\.0\.0\.1/i.test(text)) {
    return 'verification';
  }
  if (/分析|评估|架构|方案|计划|应该做什么|怎么看|review|评审/i.test(text)) {
    return 'analysis';
  }
  return 'unknown';
};

const BUSINESS_RECALL_PROMPT_KINDS = new Set(['implementation', 'verification', 'unknown']);

export const shouldRunBusinessRecall = (promptKind) => BUSINESS_RECALL_PROMPT_KINDS.has(promptKind);
