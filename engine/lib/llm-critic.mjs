#!/usr/bin/env node
// LLM 增强 critic：捕获「新增式违反禁止类需求」。
// 确定性分类器只看删除侧守卫词的消失；纯新增代码去实施某条"不得/禁止"条款的行为它看不见。
// 本模块把此类候选条款交给 LLM 做极性判定（补丁是否实施了该条款禁止的行为）。
//
// 设计约束：
// - 默认关闭：HARNESS_LLM_CRITIC=1 显式开启
// - Provider 按环境变量自动探测：ANTHROPIC_API_KEY > OPENAI_API_KEY（兼容自定义 OPENAI_BASE_URL）
// - 无 key / 超时 / 解析失败一律 fail-open：返回原 verdict，不阻断流程
// - 可注入 fetchImpl 供离线测试

const SYSTEM_PROMPT = [
  '你是软件需求契约审计员。给定一条需求条款与一段代码补丁，',
  '只判断一件事：补丁是否实施了这条条款所禁止或警告的行为。',
  '注意：条款里的"不得/禁止/必须隐藏"等约束针对的是行为本身，与代码写法无关。',
  '严格输出单行 JSON：{"violation": true|false, "reason": "不超过40字的理由"}，不要输出其他内容。'
].join('');

export const llmCriticConfig = (env = process.env) => {
  const enabled = env.HARNESS_LLM_CRITIC === '1' || env.HARNESS_LLM_CRITIC === 'true';
  const anthropicKey = env.ANTHROPIC_API_KEY ?? '';
  const openaiKey = env.OPENAI_API_KEY ?? '';
  const provider = anthropicKey ? 'anthropic' : openaiKey ? 'openai' : null;
  return {
    enabled,
    provider,
    apiKey: anthropicKey || openaiKey,
    model: env.HARNESS_LLM_MODEL ?? (anthropicKey ? 'claude-sonnet-4-5' : 'gpt-4o-mini'),
    baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    timeoutMs: Number(env.HARNESS_LLM_TIMEOUT_MS ?? 20000),
    maxRecords: Number(env.HARNESS_LLM_MAX_RECORDS ?? 3)
  };
};

const buildUserPrompt = (record, diff) => {
  const clauses = [
    record.title,
    record.clarification,
    record.mustVerify ? `验证要求：${record.mustVerify}` : ''
  ].filter(Boolean).join('\n');
  return `【需求条款】\n${clauses}\n\n【代码补丁】\n${diff}\n\n该补丁是否实施了本条款禁止/警告的行为？`;
};

const parseVerdict = (text) => {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.violation !== 'boolean') {
      return null;
    }
    return { violation: parsed.violation, reason: String(parsed.reason ?? '').slice(0, 120) };
  } catch {
    return null;
  }
};

const callProvider = async ({ config, userPrompt }, fetchImpl) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    let response;
    if (config.provider === 'anthropic') {
      response = await (fetchImpl ?? fetch)('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 200,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }]
        })
      });
    } else {
      response = await (fetchImpl ?? fetch)(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
          ]
        })
      });
    }
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const text = config.provider === 'anthropic'
      ? data?.content?.[0]?.text
      : data?.choices?.[0]?.message?.content;
    return parseVerdict(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 对单条候选记录做 LLM 极性判定。任何失败路径返回 null（fail-open）。
 */
export const llmReviewViolation = async ({ record, diff, config, fetchImpl } = {}) => {
  if (!config?.provider || !config.apiKey) {
    return null;
  }
  const userPrompt = buildUserPrompt(record, diff);
  return callProvider({ config, userPrompt }, fetchImpl);
};

/**
 * 编排入口：在确定性 verdict 之上叠加 LLM 复核。
 * - 未启用 / 无 provider / 已是 critical → 原样返回
 * - 候选选择：被确定性分类为 weak 的记录中，条款含否定信号且新增侧与其证据集有交集者
 * - 判定 violation=true 的记录升级为 conflict（severity 提到 critical）
 */
export const applyLlmCritic = async ({ verdict, recalledReqs, diff, selectCandidates, config = llmCriticConfig(), fetchImpl } = {}) => {
  if (!config.enabled || !config.provider || !verdict || verdict.severity === 'critical') {
    return { verdict, llm: { enabled: Boolean(config.enabled), checked: [], violations: [], skippedReason: config.enabled ? undefined : 'disabled' } };
  }
  if (!selectCandidates || typeof selectCandidates !== 'function') {
    return { verdict, llm: { enabled: true, checked: [], violations: [], skippedReason: 'no-selector' } };
  }
  const candidates = (selectCandidates(recalledReqs, diff) ?? []).slice(0, config.maxRecords);
  const violations = [];
  const checked = [];
  for (const candidate of candidates) {
    const outcome = await llmReviewViolation({ record: candidate.record, diff, config, fetchImpl });
    checked.push(`${candidate.record.scope}:${candidate.record.id}`);
    if (outcome?.violation) {
      violations.push({ id: `${candidate.record.scope}:${candidate.record.id}`, reason: outcome.reason });
    }
  }
  const next = { ...verdict };
  if (violations.length) {
    const violatedIds = new Set(violations.map((item) => item.id));
    next.conflicts = [...(verdict.conflicts ?? []), ...(verdict.weak ?? []).filter((record) => violatedIds.has(`${record.scope}:${record.id}`))];
    next.weak = (verdict.weak ?? []).filter((record) => !violatedIds.has(`${record.scope}:${record.id}`));
    next.severity = 'critical';
    next.notes = `LLM critic: 新增行为命中 ${violations.map((item) => `${item.id}（${item.reason}）`).join('；')}`;
  }
  return { verdict: next, llm: { enabled: true, checked, violations, skippedReason: candidates.length ? undefined : 'no-candidates' } };
};
