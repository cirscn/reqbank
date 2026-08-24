# bpms/frontend 覆盖测试发现清单（2026-08-23/24）

配套评测：`eval/coverage-100.mjs`（108 案例，11 能力组，含 K 组 Claude Code 形状），最终结果 **108/108**。
被测仓库：`/Users/aaron/Project/cirscn/bpms/frontend`（引擎 0.5.0，真源 36 REQ / 37 TC / 7 模块 + global）。

## 一、引擎缺陷（已修复）

1. **停用词表缺通用中文词（弱误召回）**：`说明/更新/文档/描述` 这类词不在 STOPWORDS，
   「更新 README.md 的说明」这类无关任务会因 TC 触发器里的「交付说明审查」被误召回。
   已修：`engine/lib/harness-store.mjs` STOPWORDS 增补四个词（已随 4b4a1e5 提交）。
2. **global 纪律条款在路径召回中被整段挤出 topK**：模块记录关键词分普遍高于 global
   条款，`src/shared/hooks/useFetch.ts` 任务 top5 全被 hooks 记录占据，global 一条都进不来，
   违背「始终读 global/index.md」的产品语义。已修：`recallByPaths` 给 global 保底一席
   （顶替末位）。smoke 回归通过。
3. **Claude Code 执法链断裂（critic 拿不到 diff + 回合标识未归一）**——2026-08-24 修复：
   - 诊断（官方文档核对 + claude 2.1.220 无头会话真实 payload 实证）：Claude Code 的
     Edit tool_input 为 `file_path + old_string/new_string`、Write 为 `file_path + content`、
     MultiEdit 为 `edits` 数组，均无 command/diff 字段，critic 原来只能 skip；
     回合标识是 `prompt_id`（turn_id 等价物），Stop 聚合与 critic 同回合去重因此失效。
     意外收获：`tool_response.structuredPatch` 直接给出 unified hunk（Write 新建时为空数组）。
   - 修法：`patch-diff.mjs` 新增 `normalizeClaudeCodeEdit`（优先消费 structuredPatch，
     回退 old/new 合成、Write 全新增、MultiEdit 逐 edit 合成）；`critic.mjs` 双形状输入
     （Codex command 通道不变）；`learning-log.mjs` 的 `parseHookPayload` 做
     `turn_id ?? prompt_id` 归一（recall/critic/finalize 全链路生效）。
   - 验证：评测新增 K 组 8 案例（payload 逐字段复刻真实探针），Edit 守卫删除判
     critical+注入、Write 不再 skipped、prompt_id 归一、跨钩子聚合 Stop 硬拦截打通、
     no-op 空编辑优雅跳过；全量 108/108 通过，smoke 回归通过。
   - 至此 README 能力矩阵中 Claude Code 的「编辑后 critic / Stop 硬拦截」真实兑现。
   - **双端活体验证（2026-08-24，claude 2.1.220 + codex-cli 0.148.0，bpms/frontend）**：
     在 src/shared/request/ 放置含守卫的探针文件，让两个 agent 真实执行「删除守卫行」——
     Claude Code：Edit → critic critical（conflict request:REQ-006）→ additionalContext 注入
     活会话 → Stop decision:block ×2；Codex：apply_patch → critical + 注入 → Stop block ×4
     → **agent 读取注入条款后自行撤销编辑并回复「未执行：删除该守卫违反 request:REQ-006」**
     → 撤销补丁判 warning → Stop allow。完整闭环：确定性冲突 → 注入 → 硬拦截倒逼整改 →
     干净收尾放行。
   - 无头运行注意事项：codex 需 `--dangerously-bypass-hook-trust`（否则 hooks.json 静默
     不加载，日志零写入）；claude 需过一次 workspace trust。

## 二、引擎局限（未改行为，建议评估）

1. **TC 的 V 命令文本污染 critic 召回排序**：TC 的 verify 字段天然富含守卫词
   （isMessageHandledError、showErrorFeedback…），路径召回时 TC 记录常把真正被违反的
   REQ 挤出 top3（实测删除 REQ-006 守卫的 diff，top3 召回的是 REQ-005 + TC-005/TC-006，
   REQ-006 本尊缺席）。好在 REQ-005 判 conflict 也是真阳性（diff 同时删了 showErrorFeedback），
   没有漏拦；但建议 critic 通道对 TC 记录降权或只召回 REQ。
2. **多模块平局挤占**：双文件任务（request + i18n）默认 top3 会被 localeCompare 靠前的
   模块整段占据，另一模块饿死（需 --top 6 才能看到）。建议 topK 按模块配额。
3. **Stop 钩子对坏 payload 走硬拦截**：stdin 非 JSON → issues 判 block。是有意设计
   （防钩子链路静默失效），但「乱输入反而拦住收尾」的语义值得再确认（评测 G05 固化）。
4. **check 矛盾检测误报率偏高**：36 条真实契约首轮 6 对误报（「守卫不得移除」类正常
   表述、模态词 必须/禁止 被当共享主题）。措辞规避后为 0。建议把 必须/禁止/不得 加入
   GENERIC_SUBJECT_STOPWORDS，或要求主题词为领域名词。
5. **后续可评估的平台能力**（官方最新 hooks，31 个事件）：PostToolBatch（整批工具后
   触发一次）、FileChanged（任意进程改文件都触发，比盯 Edit 工具难绕过）、原生
   prompt/agent 类型钩子（平台级 LLM 判定，本 kit 的 LLM critic 层可迁移）、
   无头首跑的 workspace trust 门槛（需交互确认一次或配 hasTrustDialogAccepted）。

## 三、真源沉淀经验（写 TC 的坑）

1. **文档理想 ≠ 代码现状**：AGENTS.md 说「统一 showErrorFeedback、禁止 message.error」，
   实际全库 27 处存量 message.error；「禁止 fallback={null}」实际 1 处；提交格式文档说
   `type: 描述`、实际历史是 `type  - 描述` 且含 chore。TC 应写成「存量封顶、增量防护」
   语义，漂移记进条款澄清，否则 verify 永远红。
2. **V 命令的 shell 引号陷阱**：反引号内嵌 `\'`、`\\n` 经 spawnSync(shell) + node -e
   三层转义后必炸。安全写法：纯 JS 文件遍历（fs.readdirSync 递归）或无嵌套引号的
   grep；换行用 String.fromCharCode(10)。
3. **`pnpm test -- <file>` 不传过滤参数**：pnpm 10 下会跑全量套件（246 例 / 89s），
   且该仓库全量套件本身有 ~4 例 flaky 波动。精确跑单文件用
   `pnpm exec vitest run <file>`。

## 四、被测仓库侧发现（与 harness 无关，供 bpms 团队参考）

- 全量 vitest 存在 4/246 波动用例（preview page 循环信息展示类），两次全量运行一过一挂。
- 存量漂移清单已写入真源：message.error 27 处（portal 为主）、Suspense fallback={null}
  1 处（OrdinaryQrcodePreviewPage.tsx:802）。

## 五、评测资产

- 运行器：`reqbank/eval/coverage-100.mjs`（`--only F` 可单组重跑；turn_id 带运行戳，可重复执行）
- 结果：`eval/results/coverage-report.md` + `coverage-results.json`
- 被测仓库残留（全部为新增、可 git clean 撤销）：`.harness/`、`.agentdoc/harness/`
  （含 231 行 learning-log 审计）、`.codex/hooks.json`、`.claude/settings.json`
- 备注：kit 仓库于 2026-08-24 由 harness-kit 改名为 reqbank（v0.5.1），本清单随目录迁移保留。
