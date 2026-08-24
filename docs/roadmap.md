# reqbank 提升 Roadmap（2026-08-24）

> 来源：5 路子代理深研（执法强度 / 召回注入 / 数据模型追溯 / CI 同源 / 冷启动规模化），每路均先读源码摸现状（下引 文件:行号），再对标竞品机制。竞品全景见 [competitive-research-2026-08.md](competitive-research-2026-08.md)。
> 约束不变：真源纯 Markdown、引擎纯 Node 零依赖、LLM 一律可选增强层（fail-open）、`update` 绝不触碰真源。

## 〇、先修：深研中发现的存量 bug（建议立即处理，可随 patch 发版）

| # | 问题 | 位置 | 后果 |
|---|---|---|---|
| B1 | ID 正则三位数上限 `(G?REQ-\d{3})` | harness-store.mjs:28,39,65,95；verify.mjs:58 | 第 1000 条起**静默解析失败**，条目存在但召回不到 |
| B2 | 文档与解析器漂移：README/llms.txt 示例用 `## 索引`，解析器只认 `## 内容索引` | harness-store.mjs:94 vs README:76-79、llms.txt:51、templates 使用 `## 内容索引` | 照官方文档写的 TC **静默解析为零条** |
| B3 | verify 注释宣称"逐条写 learning-log (event: verify)"但实现缺失 | verify.mjs:13（无 appendLog 调用） | 验证结果蒸发，无法回答"上次何时验证" |
| B4 | transcript.mjs 是孤儿模块：完整的会话转录解析器，全仓无调用方 | engine/lib/transcript.mjs | "从历史对话挖掘"有设计意图未接线（P4 的 mine 可复用） |
| B5 | fatal 处理器一律 `process.exit(0)` | bin/harness.mjs:516-519；verify.mjs:177-180 | 钩子 fail-open 哲学被带进 CLI/CI 场景：**引擎崩溃=门禁通过** |
| B6 | verify 在无 learning-log 环境（CI）静默打印"无命中"并 exit 0 | verify.mjs:123-126 | CI 里 verify 空转即通过 |
| B7 | Stop 门只看本回合**最后一条** critic 事件 | finalize.mjs:51-52 | 先违规编辑→再做一次干净编辑→Stop 放行，违规改动还在盘上 |
| B8 | 同文件重复 ID 经 `indexMap.set` 静默覆盖 | harness-store.mjs:30,97 | 重复条目无声丢失 |
| B9 | 根 index.md `## 已建模块` 段不参与机器解析，与目录实况可无声漂移 | templates/harness/index.md:18-20；listModuleDirs 扫目录 | 人工索引腐化无人报 |

B1-B3、B8 是纯 bug fix；B5-B7 属语义修复，纳入 P1/P2 的设计一并处理。

> **2026-08-24 验证结论：9/9 全部确认为真。**
> - **引擎实测复现（4 个）**：B1（真源含 REQ-1000，`loadAllRequirements` 解析结果中不存在）、B2（按 llms.txt:51 指引用 `## 索引` 写 tests.md，`loadAllTests` 返回 0 条；对照组改 `## 内容索引` 后 1 条）、B8（重复 REQ-001 仅剩后写条目，先写条目无声丢失）、B6（无 learning-log 时 verify exit 0 输出"无命中 TC，无需执行"）。复现方式：临时真源 + `HARNESS_PROJECT_ROOT` 指向临时目录，直接调用引擎本体。
> - **逐行源码核实（5 个）**：B3（verify.mjs 全文无 learning-log 写入，与 :13 注释不符）、B4（全仓 grep 无 transcript.mjs 调用方）、B5（bin/harness.mjs 与 verify.mjs 尾部 catch 均 `process.exit(0)`；finalize.mjs:119-122 同款但钩子场景属 fail-open 设计）、B7（finalize.mjs:50-54 `criticEvents.at(-1)` 仅看最后一条）、B9（`已建模块` 仅出现在 scope.mjs:101 的用户提示文案，无任何解析代码）。
> - **B1 机理修正**：千位 ID 行是被整行静默跳过（正则要求 3 位数字后紧跟空格+竖线/冒号，第 4 位数字使匹配失败），并非误解析为 REQ-100——比原描述更干净地"消失"。verify.mjs:58 的 `/TC-\d{3}$/` 同理，日志中出现 4 位 TC ID 时会被漏收集。

## 一、总体战略（对标结论）

1. **四层执法**：目标形态是竞品中最完整的执法链——`PreToolUse deny（写前拦截）→ PostToolUse critic（diff 对照）→ Stop 终态门（对盘上事实裁决）→ gate（pre-commit/CI 同源判决）`。当前只有中间两层，且 Stop 有绕过洞（B7）。
2. **One engine, one verdict**：critic 核心已是纯函数（critic-prompt.mjs:139,163），但唯一调用方是钩子——补 CLI 判决入口 `gate`，兑现 README"CI 门禁补偿"承诺（对标 BULDEE/ai-craftsman-superpowers、saguaro）。
3. **考古入金**：冷启动靠空模板手写是劝退点。`mine`（考古挖掘）+ `reflect`（违规回流）把 reqbank 从"手工银行"升级为"持续入金的银行"——对标 reversa（遗留反推契约）但常驻化，与"记的不是 agent 做过什么，而是业务要求它必须满足什么"的定位自洽。
4. **两个免费卖点要锁死**：① 确定性渲染天然 cache-stable（对 magic-context 的优势）——加 eval 断言"同 payload 两次运行 additionalContext 逐字节一致"；② 每回合重注入即 compaction 对抗（cc-enforcer 的核心论点）+ obsidian-mind 实证"禁止类指令才可靠传播、正向指示常被忽略"——写入 README 作为设计论据。
5. **断言层消灭 LLM 主场景**：把"禁止什么"编译成闭集断言（no-delete/forbid-add/forbid-path），确定性捕获"新增式违反"——今天这只有开 LLM critic 才能抓（对标 warrant-mcp"模型编译、代码裁决"哲学）。

## 二、分阶段计划

### P0 立即修复（周级，patch 版）✅ 已完成（2026-08-24）
> 实现：`engine/lib/harness-store.mjs`（ID 正则 4 处放宽 + tests.md 双段名兼容 + 重复 ID 检测 + 未知段名告警 + consumeParseWarnings 通道）、`engine/verify.mjs`（TC-\d{3,} + event:verify 日志）、`bin/harness.mjs`（check 消费解析警告）、README/llms.txt 示例段名修正。
> 验证：新增 `eval/p0-regression.mjs` 自包含回归 **10/10 通过**（B1 千位解析、B2 双段名等价、B8 duplicate-id 拦截+恢复、未知段名 warning 不阻断、cache-stable 逐字节一致、B3 verify 日志 2 条）；`scripts/smoke.mjs` 通过。
> ✅ 遗留已清（2026-08-24 晚）：108 案例全量基线 **108/108 通过**。背景：bpms/frontend 真源系维护者主动清空（作测试仓库用）；按 `eval/coverage-100.mjs` 的用例规格逆向重建了等价真源（36 REQ / 37 TC / 6 模块 + global，种子脚本存于 `eval/seed-bpms-bank.mjs` 可重复播种），并向 bpms 完整同步了 `.harness/{engine,bin,templates,scripts}`。基线对比：早间 0.5.0 引擎 108/108 → 0.8.0+P0 引擎 108/108，无回归。顺带修正：eval 中硬编码的版本断言 `0.5.0` 改为动态读 kit VERSION。

- [x] B1 ID 正则放宽 `\d{3,}`（S）
- [x] B2 段名统一：README/llms.txt 示例改为 `## 内容索引`，解析器兼容双段名、未知段名告警（S）
- [x] B3 verify 补 learning-log 写入（S）
- [x] B8 重复 ID 检测报错（S）
- [x] cache-stable eval 断言（S）
- 验收：eval 全绿 + 新增上述案例；REQ-1000/TC-1000 可解析可召回。✅ p0-regression 10/10；全量基线待 bpms 真源恢复后补跑。

### P1 执法无洞、召回可信（minor 版）
主题：堵绕过洞 + 修已实证的召回精度债 + 注入协议。
- [ ] **Stop 终态裁决**（M，执法维度 E1）：Stop 时对 baseline 以来变化的业务文件取 `git diff` 删除行，复用 `classifyRecord` 对盘上终态重算；回放日志保留为辅助信号。修 B7。对标 agent-spec `guard --change-scope`、cc-enforcer "声明对照盘上 mtime"。
- [ ] **trace-integrity lint**（S，D1）：悬挂 TC 引用、REQ↔TC 双向不对称、无 TC 的 REQ（铁律②从未机械化！）、重复 ID、段名契约。顺带修 B2/B8/B9。对标 doorstop integrity、agent-spec dangling satisfies、rtmx health。
- [ ] **注入预算协议**（S，R2）：`OUTPUT_CAP=10000` 常量、header 永远第一行（自定位+截断存活）、超限按整条 REQ 边界省略留指针、末行 meter。对标 cc-enforcer（"半个条文读起来像完整指令"）、obsidian-mind（"静默丢失比膨胀更糟"）。
- [ ] **分层注入**（S-M，R1）：命中的**禁止类条款（含否定信号）正文直注** L0 层，其余维持 ID-first；用 obsidian-mind 实证把"禁止语义可靠传播"用在对的层。L0 条数上限默认 3。
- [ ] **critic 通道去污染 + 模块配额**（M，R3）：critic 召回改 req-only（TC 仅在判 conflict 后补充），topK 改"每模块配额 2 + global 保底 1"；`expandRecallKeywords`/`GENERIC_RECALL_TAGS` 业务同义词从引擎硬编码移入真源 `## 召回配置` 节。修 eval/FINDINGS 已实证的"TC 挤出真违反 REQ""双模块饿死"。
- 验收：eval 复刻 FINDINGS 局限 1/2 场景通过；50 条命中合成真源下输出 ≤cap、边界完整、meter 准确；违规→干净编辑→Stop 仍 block。

### P2 条款可执行化 + CI 同源（minor 版）
主题：one engine, one verdict；写前拦截。
- [ ] **条款断言层**（M，E2）：requirements.md 新增可选 `## 断言` 节，`REQ-001 | no-delete|forbid-add|forbid-path | <pattern>` 封闭类型；critic 在 n-gram 分类器**之前**跑断言匹配，classification 归因 `{id, assertion, matched-line}`；`check` 对"含否定信号但无断言"的 REQ 报 compile-weak 警告（warrant"模糊即拒"的软化为渐进采用）。确定性捕获新增式违反，零 API 调用。
- [ ] **PreToolUse 前置拦截**（M，E4）：`pre-critic.mjs` 对 Edit/Write 的 old/new_string 跑断言匹配，命中即 `permissionDecision: deny`，消息含条款 id+断言+下一步；无断言条款走既有 PostToolUse 通道，Grok 降级不变。
- [ ] **gate 子命令**（M，C1）：`reqbank gate --staged|--base <ref>`，复用 `recallByPaths + runCriticReview` 纯函数链，exit 1 当且仅当确定性 conflict；learning-log 记 `event:'gate'`。修 B5（`HARNESS_GATE=1` 下 fatal exit 2）与 B6（`verify --all` 全库枚举不依赖日志）。
- [ ] **init --gate 装配**（S，C2）：幂等渲染 `.git/hooks/pre-commit` + `.github/workflows/reqbank-gate.yml`（check --strict → gate --base → verify --all）。README 从"建议配合 CI 门禁补偿"改为"`init --gate` 一键装配"。
- [ ] **LLM critic 升级**（S-M，E3）：输出四字段 `{violation, clause_quote, diff_quote, next_step}`；quote 做子串回验（幻觉到不了决策路径）；`.agentdoc/harness/cache/` 按 sha256(req-id+diff) 缓存 verdict；注入升级三段式（条款引文/证据行/Recovery 下一步）。
- 验收：断言案例 ≥8 个全过；staged 违规 commit 被拒；同 diff 二次触发 LLM 调用数为 0；quote 不匹配被丢弃且日志记 skippedReason。

### P3 银行账目：生命周期与追溯（minor 版）
主题：条目可演进、验证可查、报告可运营。
- [ ] **生命周期状态机**（M，D2）：索引行扩 5 列 `| active|draft|superseded>REQ-009`，旧 4 列默认 active 零迁移；非 active 不参与召回/执法；取代链查环；`reqbank status` 汇总分布。对标 total-recall [superseded] 永不删除、agent-spec transition。
- [ ] **置信度标注**（S-M，S2）：可选第 5 列 `confirmed|inferred|gap`（缺省 confirmed）；`reqbank confirm <id>` 人审升级；置信度只驱动人审队列不参与执法。对标 reversa 三色置信度、FredAntB [TO VERIFY]。与 P4 的 mine 配套（候选一律落 inferred/gap）。
- [ ] **verify 回写 + status 三态派生**（M，D3）：verify 事件落 learning-log（修 B3）；`status` 从日志派生 verified/unproven/stale/violated（REQ 取其 TC 最差值），状态永不写回真源（agent-spec "liveness recomputed, never stored"）。
- [ ] **漂移检测**（S-M，D4）：命中路径 glob 零匹配→dead-path 警告；根 index 已建模块与目录双向 diff；补 `**` 跨目录 glob 语义。对标 OpenLore（README 自己列了却没吸收）、mex check。
- [ ] **report 2.0**（S-M，E6+R5+C4 合并）：① REQ 终态矩阵（conflict/covered/weak/never-seen）；② `--by-req` 合规统计 + block 整改率 + dead-rule 清单；③ 召回质量（策略分布、context_chars 直方图、召回闭环率=同 turn_id 的 prompt 召回∩diff 召回、执法消费率）；④ `--snapshot` 棘轮（快照进版本库，CI 比对不匹配 exit 1——duvet 式"度量本身成为门禁"）。
- [ ] **门禁分级与豁免**（M，C5）：条款级 `| warn` 后缀（默认 block 语义不变）；内联抑制 `// reqbank-ignore: <id>`（必须 counted 进 report）；`gate --freeze` 存量冻结基线（存量只 warn、新增照 block）。对标 cupcake 五态、BULDEE counted suppression、OpenLore frozen。硬门禁的误报出口，防门禁被整体关掉。
- 验收：superseded 不再召回；freeze 后存量放行新增拦截；快照 diff 指向新增未验证 REQ；report 数值可用手工统计核对。

### P4 冷启动与规模化：考古入金（major 叙事）
主题：把"手工银行"升级为"持续入金的银行"。
- [ ] **reqbank mine 挖掘**（L，S1）：确定性层（无 LLM 默认）——`git log --grep` 修复主题、热点文件、AGENTS.md/README 约定段、TODO/FIXME、存量用法计数（"存量封顶、增量防护"句式）；LLM 增强层可选（`HARNESS_LLM_DRAFT=1` 起草正文，fail-open）；候选一律写 `.agentdoc/harness/inbox/*.md` 草稿区，人审后入库，按领域分批。对标 agent-os discover-standards 六步、reversa 五阶段考古。
- [ ] **reflect 违规回流**（M，S3）：Stop block 时向 inbox 追加冲突事件卡（条款 ID+diff 摘要+turn_id）；reflect 聚合重复模式生成条款建议（"条款 X 30 天违规 3 次：建议把守卫写成 TC 的 V 命令""路径 12 次改动零召回：建议登记模块"）；接线孤儿模块 transcript.mjs 消费会话纠错发言作候选证据。对标 mex check/sync 修复回路、reversa Emendas。
- [ ] **检索缓存与索引**（M，S4②③）：进程内 mtime 缓存（修"一次 PostToolUse=两层全库扫描"）；可选倒排索引 `.index.json`（tag→条款、路径→模块），mtime 指纹校验、可随时重建——保持"真源是唯一事实"原则。
- [ ] **learning-log 轮转 + 增量读**（M，S5）：字节偏移增量读，超 5MB 轮转；修"每次 Stop 全量重读"。
- [ ] **沉淀引导向导**（S，S6）：templates 增加 agent-guide.md 起草协议（先扫存量用法→逐条问三个问题→起草 REQ+TC→scope/check 自验→登记）。对标 agent-os"问 why 不批量"、FredAntB 四问。
- [ ] **Stop 自动验证命中 TC**（M-L，E5）：Stop 对判 conflict 的 REQ 自动执行关联 TC 的 V 命令（复用 verify 的 UNSAFE_CHECKS fail-closed）：TC 失败→block 引用 TC id；TC 通过→降级 warning 附人工确认提示。命令执行风险边界保守设计。
- 验收：有 git 历史仓库无 LLM env 下 mine 输出候选 JSONL 且每条含 evidence；1000 条真源 scope 耗时降至首扫 1/5 内；构造 critical 回合后 inbox 出现事件卡；5MB 日志 Stop 耗时显著下降。

### 机会项（顺手做，不占里程碑）
- `reqbank why <file>`：code→REQ 反查 + 验证状态列（D6，S）；与 critic 共享路径匹配代码保证"查询=执法"。
- stamp git trailers：`Reqbank-Passing: true` 写进提交元数据（C6，S）；对标 agent-spec stamp。
- PreCompact 钩子 + SessionStart 契约摘要（R4，M）；Codex 无此事件则能力矩阵如实标注。
- REQ matchHints 匹配提示字段（R6，M）；对标 ai-nexus frontmatter description 自举。
- 条款语言 lint：无义务词/模糊词（尽量/适当）/复合义务拆分建议（D5，S）；对标 agent-spec EARS。
- 审计防篡改哈希链（arai）；受众不匹配，长期 backlog。

## 三、优先级总览

| 阶段 | 主题 | 核心交付 | 修的 bug |
|---|---|---|---|
| P0 | 正确性止血 | ID 上限/段名漂移/verify 日志/重复 ID/cache 断言 | B1 B2 B3 B8 |
| P1 | 执法无洞、召回可信 | Stop 终态裁决、trace-integrity、注入预算+分层、critic 去污染 | B7 B9 |
| P2 | 条款可执行化 + CI 同源 | 断言层、PreToolUse deny、gate + init --gate、LLM critic 升级 | B5 B6 |
| P3 | 银行账目 | 生命周期、置信度、status 派生、漂移检测、report 2.0、门禁分级 | — |
| P4 | 考古入金 | mine、reflect、缓存索引、日志轮转、Stop 自动 TC | B4（transcript 接线） |

各提案的完整设计细节（含全部 文件:行号 引用与对标机制出处）保留在本次五路深研报告中；实施任一项时建议先重读对应维度的源码现状段落。
