# reqbank 竞品调研报告（2026-08-24）

> 方法：4 路并行子代理检索——① 钩子执法/guardrails ② 规格驱动/需求追溯 ③ 记忆与规则注入 ④ 社区生态大扫荡。
> 渠道：GitHub API/搜索、awesome-claude-code / awesome-codex-cli / awesome-context-engineering 等清单、HN Algolia、npm。
> 未覆盖：Reddit/X（反爬）、掘金/V2EX（JS 渲染抓不到）。star 数为当日快照约值。
> 已知基线（README 参考生态表，本报告不重复）：mex、codebase-memory-mcp、OpenSpec、OpenLore、spec-kit、superpowers、BMAD-METHOD、claude-mem、mem0、awesome-claude-code。

## 一、总体结论

1. **reqbank 的四件套组合仍是空位**：结构化 REQ/TC 条目（纯 Markdown 真源）＋ 路径/glob→标签的每回合召回注入 ＋ diff 对照条款 critic ＋ Stop 确定性硬拦截 ＋ 多 agent 通用。四路共扫出 40+ 个项目，无一同时占齐。
2. **但"机制近邻"不再是零**，且分化成三条已有赛道：spec 生成瀑布流（gsd/spec-kit/cc-sdd）、过程记忆（agentmemory/ai-memory）、安全政策（cupcake/cc-safety-net）。reqbank 卡的是三者交叉点。
3. **最近的直接竞品**：saguaro（机制逐点同构，但管 lint 规范不是业务契约）、agent-spec（契约+确定性 gate+追溯最完整，但执法在 commit 时点、绑 Rust）、moai-adk（覆盖最重的 harness）、FredAntB/SDD（REQ 语义最接近，HN 公测期）。
4. **窗口判断**：FredAntB 在 HN 找测试者、agent-spec 447★ 上升期、saguaro 属同格子先占者——这个空位可能在 6-12 个月内被填，值得加快叙事占位。

## 二、第一梯队：直接竞品（建议人工逐条复核）

| 项目 | Stars | 一句话 | 与 reqbank 重叠 | 关键差异 |
|---|---|---|---|---|
| [mesa-dot-dev/saguaro](https://github.com/mesa-dot-dev/saguaro) | 26 | 本地规则引擎 code review：`.saguaro/rules/*.md`（frontmatter: id/severity/globs），PreToolUse 注入匹配规则，Stop 审 diff 违规 exit 1 | **机制几乎逐点同构**，且同支持 Claude/Codex/Gemini/Cursor | 面向团队编码规范（lint 类）；无 REQ/TC 业务契约语义、无条目积累/标签化检索、无 TC 验证命令执行 |
| [ZhangHanDong/agent-spec](https://github.com/ZhangHanDong/agent-spec) | 447 | 意图→需求 IR→Task Contract，EARS/ISO-29148 lint，trace 三态追溯（honored/violated/unproven），全确定性 gate | **契约+确定性执法+追溯最完整** | 执法时点在 pre-commit/CI 而非每回合召回；契约按任务组织非全局常驻库；绑 Rust 生态 |
| [modu-ai/moai-adk](https://github.com/modu-ai/moai-adk) | ~1.2k | 包装 Claude Code 的可验证输出 harness：SPEC-xxx（GEARS 格式）+ 钩子机械执法的 TRUST 5 质量门 + trust-but-verify 重跑 7 项验证 + 漂移检测 MCP | SPEC 条目+验收标准+钩子门控+漂移检测全覆盖 | Go 单二进制 12-agent 编排的重量级 harness；锁 Claude Code；reqbank 是轻量库+横向多代理 |
| [FredAntB/Spec-Driven-Development](https://github.com/FredAntB/Spec-Driven-Development) | 147 | Claude skill：REQ-xxx（shall+验收标准），"never implement unlisted requirements" 宪法，67 静态断言+53 质量检查 CI 门 | **REQ 条目语义最接近** | 只在生成期起作用，运行期靠 CLAUDE.md 自律；无钩子召回/diff critic/收尾拦截；HN 公测期（Show HN 40 分） |
| [taniwhaai/arai](https://github.com/taniwhaai/arai) | 7 | CLAUDE.md/AGENTS.md/.cursorrules 即政策：自动提取祈使句（带来源行号），PreToolUse 拦截+合规判定+哈希链审计 | "契约文件→钩子执法"理念相同，多 agent（Claude/Grok） | 从散装 instruction 自动提取，非人治理的 REQ/TC 真源；注入按工具调用匹配非每回合；无 TC 验证 |
| [skymanbp/cc-enforcer](https://github.com/skymanbp/cc-enforcer) | 4 | SessionStart+UserPromptSubmit 每回合重注入规则摘要，PreToolUse 硬 DENY，Stop 九层完成声明审查 | **钩子布阵与 reqbank 一一对应**；规则也是编号结构化 md | 规则内容是"反偷懒行为纪律"非业务契约；全量注入非标签召回；仅 Claude Code 完整支持 |
| [pdewost/coding-constitution](https://github.com/pdewost/coding-constitution) | 11 | "无法执法的规则就不算规则"：ANCHOR 会话注入 + GUARDRAIL 每 prompt 注入 + COMPILE-GATE 编辑后检查 + CLOSEOUT-GATE 收尾拦截 | **钩子机制逐点对应** | 管通用工程纪律非 REQ/TC；无标签召回、无验证命令；极小众 |
| [mrvladd-d/memobank](https://github.com/mrvladd-d/memobank) | 54 | Agent-first Memory Bank：requirements.md/constitution.md/spec-index + 确定性 mb-lint + /verify 与对抗性 /red-verify 门 | **概念组合几乎一一对应** | 召回靠 slash 命令/AGENTS.md 自读，无钩子自动注入、无 diff 对照、无硬拦截 |

## 三、第二梯队：单维近邻（各占 reqbank 一个侧面）

| 项目 | Stars | 占住的维度 | 缺什么 |
|---|---|---|---|
| [av/facts](https://github.com/av/facts) | 199 | 条款内联可执行验证命令（`command: grep -q ...`，`facts check` 一键验证）——最像 TC | 无每回合执法、无追溯矩阵、无 diff critic |
| [awslabs/duvet](https://github.com/awslabs/duvet) | 156 | REQ↔TC 注释级双向追溯 + 测试执行关联（AWS 官方，aws-sdk-rust 在用） | 纯 CI 时点，无 agent 集成 |
| [rtmx-ai/rtmx](https://github.com/rtmx-ai/rtmx) | 29 | 需求状态由测试结果派生 + MCP 供 agent 读写需求 + 结构健康检查 | CSV 非 Markdown；无钩子注入/拦截 |
| [eqtylab/cupcake](https://github.com/eqtylab/cupcake) | 286 | 政策执法工程成熟度：OPA/Rego→Wasm，Allow/Modify/Block/Warn/Require-Review，多 agent | Rego 安全政策非业务契约；明确定位不占上下文（无召回注入） |
| [nizos/probity](https://github.com/nizos/probity)（前身 tdd-guard 2311★） | 177 | 多 agent 规则+AI 混合判定，写前拦截 | 规则是代码函数非条文；只拦不注；限 TDD 域 |
| [JSK9999/ai-nexus](https://github.com/JSK9999/ai-nexus) | 18 | 每条 prompt 前 hook + 离线关键词确定性路由 + 只注入命中子集——**注入层低配版** | 管偏好规则非 REQ/TC；无 glob→标签索引、无执法 |
| [jayminwest/mulch](https://github.com/jayminwest/mulch) | 330 | 确定性 scoping（按 git 工作集裁剪）+ hook 非零退出即 block 的 API | JSONL 真源；session start 注入非每回合；无契约执法 |
| [breferrari/obsidian-mind](https://github.com/breferrari/obsidian-mind) | ~4.5k | UserPromptSubmit 每回合 hook + PostToolUse block（唯一双全） | 语义向量召回；过程记忆非契约；拦截只管文件摆放 |
| [infinri/Writ](https://github.com/infinri/Writ) | 187 | 治理运行时：规则检索注入+工具时拦截+一次性密钥门控+决策溯源 | 定位治理/审计；Docker+Neo4j 重依赖；单 Claude Code；自述有绕过缺口 |
| [doorstop-dev/doorstop](https://github.com/doorstop-dev/doorstop) | 659 | REQ/TC 数据模型（YAML 条目+link 追溯链）的 传统 正统实现 | 无 AI、无验证执行、无钩子 |
| [zhu1098747315/spec_driven_develop](https://github.com/zhu1098747315/spec_driven_develop) | 972 | 漂移量化执法（drift_score 分级门控）+ 独立 reviewer 子代理 | skill 指令驱动非确定性钩子；无契约库语义 |
| BULDEEI/ai-craftsman-superpowers | 34 | **"one engine, one verdict"：同一规则引擎跑钩子+CI** | 域是架构规范（YAML+栈 pack）；纯拦截无注入 |

## 四、第三梯队：大热度但差异化清晰（一句话备案）

- **spec 瀑布流**：gsd-build/get-shit-done（64.6k★，新版 gsd-2 7.7k★）、Pimzino/spec-workflow-mcp（4.3k★）、gotalab/cc-sdd（3.6k★）、buildermethods/agent-os（5.3k★，"按需注入 standards" 与召回思路相通）、gemini-cli-extensions/conductor（3.7k★）——一次性生成规格再实现，非常驻契约执法。
- **过程记忆**：rohitg00/agentmemory（27.3k★，BM25+向量+图谱混合召回、20+ agent、但注入默认关闭）、akitaonrails/ai-memory（4.3k★，明言"检索文本绝不获得指令权威"——与 reqbank 契约权威化哲学相反）、obsidian-second-brain（4.2k★）、magic-context（1.9k★，每回合注入但纯语义）、ensue-skill（421★）、total-recall（201★，结构化 claims+superseded 生命周期）、projectmem（748★，precheck 可 snooze 非硬拦）。
- **安全红线/QA 门**：kenryu42/cc-safety-net（1504★，12 agent 破坏性命令拦截）、first-fluke/oh-my-agent（1246★，Stop 门禁+独立 QA 裁判+验收标准逐条重验）、provos/ironcurtain（587★，宪法→确定性策略→逐 tool call 裁决）、faramesh-core（101★，daemon 确定性执法+哈希链审计）、warrant-mcp（1★，封闭安全原语但"决策归因到条款编号"哲学相同）。
- **规则文件同步**：dyoshikawa/rulesync（1.3k★，20+ 工具生成/转换）、ai-rules-sync（118★，AGENTS.md 单真源 any-to-any）——构建时全量生成，无运行时按 scope 召回。
- **方法论话语**：VSDD（Verified SDD，HN 211 分）"契约链把每条需求链接到验证属性/测试/证明"——是 reqbank 叙事的直接竞品话语，值得文档对照回应。
- **其他**：Agile-V/agile_v_skills（51★，冻结需求基线+类型化追溯，skill 约定无代码执法）、sandeco/reversa（1.5k★，遗留系统反向工程成可执行契约——reqbank 冷启动的镜像场景）、GAAI-framework（160★，"backlog is contract"但自述无程序化执法）、shotgun（681★，规格编写侧）、LeaiFish/proof-of-done（0★，"收尾验收硬闸"点位重合但极早期）。

## 五、对 reqbank 的战略启示

### 1. 定位叙事
市场三条已有线（spec 瀑布流 / 过程记忆 / 安全政策）都没有"业务契约常驻＋确定性召回＋收尾硬拦"。差异化句式可锚定：**"记的不是 agent 做过什么，而是业务要求它必须满足什么"**（对过程记忆）、**"契约在每回合被召回执法，不是生成完就翻篇"**（对 SDD 瀑布流）、**"条款是业务 REQ/TC 不是 Rego 安全政策"**（对 cupcake）。

### 2. 可直接借鉴的设计
- **cc-enforcer**：每回合重注入是对抗上下文压缩的实证做法——reqbank 的 UserPromptSubmit 注入可强调同样动机。
- **obsidian-mind 实测结论**：MCP/注入里的正向指示（"去查某文档"）常被 agent 忽略，禁止类指令才可靠传播——**这是"Stop 硬拦截＋每回合重注入"必要性的外部证据，可引入 README 论证**。
- **mulch**：hook 非零退出即 block + 可变更 payload 的拦截层 API 先例。
- **BULDEEI/ai-craftsman-superpowers**：同一规则引擎同源跑钩子与 CI（"one engine, one verdict, no drift"）——reqbank 做 CI 门禁时可采同思路。
- **agent-spec**：trace 三态（honored/violated/unproven）比二值通过/失败更诚实，report 可借鉴。
- **doorstop/duvet**：REQ↔TC link 的成熟数据模型参考。

### 3. 竞争窗口
FredAntB/SDD 公测找用户、agent-spec 上升期、saguaro 同格子先占（虽仅 26★）。建议：README"参考生态"表增补 agent-spec、facts、saguaro、cupcake、coding-constitution、duvet；季度巡检重点盯这 6 个 + cc-enforcer/arai 的演化。

### 4. 渠道盲区（下次补）
Reddit r/ClaudeAI、X、掘金/V2EX 本轮未覆盖（反爬/渲染限制）；中文社区仅通过 GitHub 侧发现 spec_driven_develop（972★，中文作者）。
