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

### P1 执法无洞、召回可信（minor 版）✅ 已完成（2026-08-24）
> 实现：`engine/finalize.mjs`（终态裁决：对本轮新增/变化的业务文件取盘上 git diff，复用 classifyRecord 重算，fail-open）；`engine/lib/lint.mjs` + `bin/harness.mjs`（lintTraceIntegrity：悬挂/不对称=error，无TC/索引漂移=warning、--strict 升级）；`engine/lib/critic-prompt.mjs`（RECALL_OUTPUT_CAP=10000 + 分层注入 L0/L1 + header 首行 + 整条省略 + meter 末行）；`engine/critic.mjs`（召回 req-only + 每模块配额 2）；`engine/lib/harness-store.mjs`（召回配置数据化：根 index「## 召回配置」节可覆盖通用标签/同义词组，缺省回落内置）。
> 验证：新增 `eval/p1-regression.mjs` **17/17**——含 B7 真实复现（git 仓库删守卫、无 critic 事件、Stop 终态裁决拦截 + 撤销后放行）、trace-integrity 四场景、分层注入端到端、截断 cache-stable、critic 去污染（recall_ids 零 TC）、双模块配额、真源同义词组驱动召回；`p0-regression` 10/10；**108 案例全量 108/108 零回归**。
> 顺手修复（深研清单外新发现）：索引行中间列留空（`REQ-x | tags |  | 标题`）时正则整行静默丢弃——与 B2 同类的格式契约静默失效，已改为解析为 relatedTests=[] 并由铁律②警告接住。

- [x] **Stop 终态裁决**（M，执法维度 E1）：修 B7。对标 agent-spec `guard --change-scope`、cc-enforcer「声明对照盘上 mtime」。
- [x] **trace-integrity lint**（S，D1）：悬挂 TC 引用 / REQ↔TC 双向不对称（error）；无 TC 的 REQ（铁律②首次机械化）/ 根索引与目录双向 diff 修 B9（warning）。对标 doorstop、agent-spec、rtmx health。
- [x] **注入预算协议**（S，R2）：OUTPUT_CAP=10000 公开常量；header 永远第一行；超限按整条省略留指针；末行 meter。对标 cc-enforcer、obsidian-mind。
- [x] **分层注入**（S-M，R1）：含否定信号 REQ 的 clarification 正文直注（L0，上限 3 条），其余 ID-first（L1）。obsidian-mind 实证依据。
- [x] **critic 通道去污染 + 模块配额**（M，R3）：critic 召回 req-only（TC 判冲突后按需补充）+ 每模块配额 2 + 业务同义词/通用标签移入真源「召回配置」节。修 eval/FINDINGS 实证的两个漏召。
- 验收：eval 复刻 FINDINGS 局限 1/2 场景通过；50 条命中合成真源下输出 ≤cap、边界完整、meter 准确；违规→干净编辑→Stop 仍 block。

### P2 条款可执行化 + CI 同源（minor 版）✅ 已完成（2026-08-24）
> 实现：`engine/lib/assertions.mjs` +「## 断言」解析（no-delete/forbid-add/forbid-path 闭集，critic 前置匹配带归因 + compile-weak 提示）；`engine/pre-critic.mjs`（PreToolUse 写前 deny，claude 适配器注册）；`engine/gate.mjs`（--staged/--base/dirty 三模式 fail-closed，与钩子同源判定链）；`init --gate`（pre-commit + reqbank-gate.yml）；LLM critic 四字段输出 + 子串回验 + 磁盘缓存；B5/B6 修复（HARNESS_GATE=1 fail-closed、verify --all）。
> 验证：`eval/p2-regression.mjs` **23/23**——含 git commit 被 pre-commit 真实拒绝的 E2E、崩溃语义矩阵、LLM 幻觉引文丢弃。
主题：one engine, one verdict；写前拦截。
- [x] **条款断言层**（M，E2）：requirements.md 新增可选 `## 断言` 节，`REQ-001 | no-delete|forbid-add|forbid-path | <pattern>` 封闭类型；critic 在 n-gram 分类器**之前**跑断言匹配，classification 归因 `{id, assertion, matched-line}`；`check` 对"含否定信号但无断言"的 REQ 报 compile-weak 警告（warrant"模糊即拒"的软化为渐进采用）。确定性捕获新增式违反，零 API 调用。
- [x] **PreToolUse 前置拦截**（M，E4）：`pre-critic.mjs` 对 Edit/Write 的 old/new_string 跑断言匹配，命中即 `permissionDecision: deny`，消息含条款 id+断言+下一步；无断言条款走既有 PostToolUse 通道，Grok 降级不变。
- [x] **gate 子命令**（M，C1）：`reqbank gate --staged|--base <ref>`，复用 `recallByPaths + runCriticReview` 纯函数链，exit 1 当且仅当确定性 conflict；learning-log 记 `event:'gate'`。修 B5（`HARNESS_GATE=1` 下 fatal exit 2）与 B6（`verify --all` 全库枚举不依赖日志）。
- [x] **init --gate 装配**（S，C2）：幂等渲染 `.git/hooks/pre-commit` + `.github/workflows/reqbank-gate.yml`（check --strict → gate --base → verify --all）。README 从"建议配合 CI 门禁补偿"改为"`init --gate` 一键装配"。
- [x] **LLM critic 升级**（S-M，E3）：输出四字段 `{violation, clause_quote, diff_quote, next_step}`；quote 做子串回验（幻觉到不了决策路径）；`.agentdoc/harness/cache/` 按 sha256(req-id+diff) 缓存 verdict；注入升级三段式（条款引文/证据行/Recovery 下一步）。
- 验收：断言案例 ≥8 个全过；staged 违规 commit 被拒；同 diff 二次触发 LLM 调用数为 0；quote 不匹配被丢弃且日志记 skippedReason。

### P3 银行账目：生命周期与追溯（minor 版）✅ 已完成（2026-08-24）
> 实现：索引可选第 5 列 `active|draft|superseded>REQ-x` `:confirmed|inferred|gap` `:warn`（旧 4 列零迁移，active 过滤贯通召回/执法/验证）；`reqbank confirm` 人审；`engine/status.mjs` 三态派生（verified/unproven/stale/violated，永不写回真源）；漂移检测（dead-path via git ls-files + `**` glob）；report 2.0（终态矩阵/整改率/召回闭环率/执法消费率/dead-rule/--snapshot 棘轮）；内联抑制（counted）+ `:warn` 降级 + `gate --freeze`（坏基线 fail-closed）。
> 验证：`eval/p3p4-regression.mjs` P3 部分。
主题：条目可演进、验证可查、报告可运营。
- [x] **生命周期状态机**（M，D2）：索引行扩 5 列 `| active|draft|superseded>REQ-009`，旧 4 列默认 active 零迁移；非 active 不参与召回/执法；取代链查环；`reqbank status` 汇总分布。对标 total-recall [superseded] 永不删除、agent-spec transition。
- [x] **置信度标注**（S-M，S2）：可选第 5 列 `confirmed|inferred|gap`（缺省 confirmed）；`reqbank confirm <id>` 人审升级；置信度只驱动人审队列不参与执法。对标 reversa 三色置信度、FredAntB [TO VERIFY]。与 P4 的 mine 配套（候选一律落 inferred/gap）。
- [x] **verify 回写 + status 三态派生**（M，D3）：verify 事件落 learning-log（修 B3）；`status` 从日志派生 verified/unproven/stale/violated（REQ 取其 TC 最差值），状态永不写回真源（agent-spec "liveness recomputed, never stored"）。
- [x] **漂移检测**（S-M，D4）：命中路径 glob 零匹配→dead-path 警告；根 index 已建模块与目录双向 diff；补 `**` 跨目录 glob 语义。对标 OpenLore（README 自己列了却没吸收）、mex check。
- [x] **report 2.0**（S-M，E6+R5+C4 合并）：① REQ 终态矩阵（conflict/covered/weak/never-seen）；② `--by-req` 合规统计 + block 整改率 + dead-rule 清单；③ 召回质量（策略分布、context_chars 直方图、召回闭环率=同 turn_id 的 prompt 召回∩diff 召回、执法消费率）；④ `--snapshot` 棘轮（快照进版本库，CI 比对不匹配 exit 1——duvet 式"度量本身成为门禁"）。
- [x] **门禁分级与豁免**（M，C5）：条款级 `| warn` 后缀（默认 block 语义不变）；内联抑制 `// reqbank-ignore: <id>`（必须 counted 进 report）；`gate --freeze` 存量冻结基线（存量只 warn、新增照 block）。对标 cupcake 五态、BULDEE counted suppression、OpenLore frozen。硬门禁的误报出口，防门禁被整体关掉。
- 验收：superseded 不再召回；freeze 后存量放行新增拦截；快照 diff 指向新增未验证 REQ；report 数值可用手工统计核对。

### P4 冷启动与规模化：考古入金（major 叙事）✅ 已完成（2026-08-24）
> 实现：`engine/mine.mjs`（instruction/git-fix/todo/hotspot 四源考古 → inbox/ 草稿区，永不直写 modules/）；`engine/reflect.mjs`（重复冲突/零召回路径回流 + --transcript 接线孤儿模块 transcript.mjs 修 B4 + 用户纠错候选）；harness-store mtime 缓存（修两层全库扫描）；learning-log 轮转 + 增量读；agent-guide.md 起草向导；Stop 自动验证命中 TC（HARNESS_STOP_VERIFY=1 门控，TC 失败 block/全过降级，危险命令确定性拒绝）；终态裁决接入断言层与 critic 同源。
> 验证：`eval/p3p4-regression.mjs` P4 部分。
> **Roadmap P0–P4 全部完成**：28 项提案 + 9 bug 修复；总回归 **71/71**（10+17+23+21）+ 108 全量零回归。
主题：把"手工银行"升级为"持续入金的银行"。
- [x] **reqbank mine 挖掘**（L，S1）：确定性层（无 LLM 默认）——`git log --grep` 修复主题、热点文件、AGENTS.md/README 约定段、TODO/FIXME、存量用法计数（"存量封顶、增量防护"句式）；LLM 增强层可选（`HARNESS_LLM_DRAFT=1` 起草正文，fail-open）；候选一律写 `.agentdoc/harness/inbox/*.md` 草稿区，人审后入库，按领域分批。对标 agent-os discover-standards 六步、reversa 五阶段考古。
- [x] **reflect 违规回流**（M，S3）：Stop block 时向 inbox 追加冲突事件卡（条款 ID+diff 摘要+turn_id）；reflect 聚合重复模式生成条款建议（"条款 X 30 天违规 3 次：建议把守卫写成 TC 的 V 命令""路径 12 次改动零召回：建议登记模块"）；接线孤儿模块 transcript.mjs 消费会话纠错发言作候选证据。对标 mex check/sync 修复回路、reversa Emendas。
- [x] **检索缓存与索引**（M，S4②③）：进程内 mtime 缓存（修"一次 PostToolUse=两层全库扫描"）；可选倒排索引 `.index.json`（tag→条款、路径→模块），mtime 指纹校验、可随时重建——保持"真源是唯一事实"原则。
- [x] **learning-log 轮转 + 增量读**（M，S5）：字节偏移增量读，超 5MB 轮转；修"每次 Stop 全量重读"。
- [x] **沉淀引导向导**（S，S6）：templates 增加 agent-guide.md 起草协议（先扫存量用法→逐条问三个问题→起草 REQ+TC→scope/check 自验→登记）。对标 agent-os"问 why 不批量"、FredAntB 四问。
- [x] **Stop 自动验证命中 TC**（M-L，E5）：Stop 对判 conflict 的 REQ 自动执行关联 TC 的 V 命令（复用 verify 的 UNSAFE_CHECKS fail-closed）：TC 失败→block 引用 TC id；TC 通过→降级 warning 附人工确认提示。命令执行风险边界保守设计。
- 验收：有 git 历史仓库无 LLM env 下 mine 输出候选 JSONL 且每条含 evidence；1000 条真源 scope 耗时降至首扫 1/5 内；构造 critical 回合后 inbox 出现事件卡；5MB 日志 Stop 耗时显著下降。

### P5 语义检测升级：标点 token + tree-sitter WASM（✅ 2026-08-25 实施）
主题：关闭确定性检测的最后两个盲区（极性翻转 / 连接符翻转），把断言层从"字面匹配"升级为"语法感知"。对标 arai（tree-sitter + 预筛），但走 WASM 通道守住纯 Node / 全平台 / 零安装底线。
- [x] **L1 标点感知 token**（S）：`detectBooleanFlip` 从原始 diff 行提取布尔三元组（注释行豁免），同操作数下 `&&`↔`||` 或裸/取反互换判确定性 conflict，归因给带禁止语义的召回条款；操作数交换（a&&b↔b&&a）等价改写不误报。全语言生效（含无语法包语言），critic/Stop/gate 一处实现自动继承。验收：对抗评测 ATK-FLIP 从"已知盲区"翻转为"已拦截"（另加 ATK-FLIP-BENIGN 等价改写对照）。
- [x] **L2 tree-sitter WASM**（M-L）：vendor 运行时 web-tree-sitter@0.22.6（~256KB）+ 语法包 7 件 **JS/JSX、TS、TSX、Java、Python、Go、Rust** brotli 压缩（~539KB，合计 ~800KB，优于 2.1MB 预估）、按文件后缀懒加载（LAZY 用例验证用不到的语言不进内存）、字符串预筛命中才解析（无断言回合零 WASM 成本）、片段用完即弃（无索引无漂移）。断言新增 `forbid-call`（AST 确认调用点，注释/字符串提及被干净解析推翻——JAVA-MENTION 用例）与 `no-negate`（结构化极性守卫，`!x`/`not x`）。`reqbank lang add/list/remove` 按需扩展语言（npm registry 下载 tree-sitter-wasms 语法包 → brotli → `.agentdoc/harness/vendor-lang/` 随仓库共享；kotlin 端到端用例 LANG-ADD/USE/REMOVE）。声明式配置（YAML/JSON/HTML/CSS）明确不做 AST——字符串断言层即正确工具。
- 设计约束落实：语法包静态 .wasm（Node 22 内置 WASM 引擎执行，Windows/Linux/macOS/ARM 一份通用）；`engine/vendor/**` .gitattributes 标记 linguist-generated；VENDOR.json sha256 清单 + `reqbank check --vendor` 完整性校验（TAMPER 用例：篡改被抓、还原恢复）；版本配对约束记录于 vendor NOTICE.md（web-tree-sitter 0.26 拒绝旧 dylink 格式语法包，升级必须成对验证）；四处执法入口（pre-critic/critic/Stop/gate）经 assertions.mjs 一处实现自动继承（PRE-DENY 用例验证写前拦截）。
- 验收：Java 真实文件 forbid-call 拦截 + 注释提及不误报（JAVA-CALL/JAVA-MENTION）✅；TS 文件 `!x` 翻转拦截（TS-NEGATE）✅；语法包懒加载内存验证（LAZY）✅；六套回归（P0-P5 + 对抗）104 用例 + 108 全量零回归 ✅。
- **真实项目验收（2026-08-25，eval/acceptance-p5.mjs，13/13）**：bpms/frontend 真实 TS 代码库四层拦截同一取反翻转（pre-critic deny → critic critical → gate exit 1 → Stop block）；跨模块 forbid-call（hooks 文件违规调用被 request 条款归因拦截）；注释提及/合法 antdMessage.error 通道零误报；agent.ts 真实条件翻转 L1 无断言拦截；backend 真实 Java 文件 20/20 整文件解析干净 + 真实方法名 forbid-call；干净工作区 gate 2.2s。验收发现并当场修复两处引擎缺陷：成员式 pattern（message.error）AST 确认尾段对齐、断言层改为全库扫描（此前跨模块违规可绕过召回门控）——回归 104 + 108 用例全绿后随 0.10.1 发布。

### 机会项（顺手做，不占里程碑）
- Stop 完成声明审查（cc-enforcer 九层思路：对冲词/盘上 mtime 对照/声称改了 X 但文件未动）——与终态裁决天然互补，正交的一层。
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
| P5 | 语义检测升级 | L1 标点翻转判定、L2 tree-sitter WASM 结构化断言（forbid-call/no-negate）、lang 命令 | 极性/连接符翻转盲区 |

各提案的完整设计细节（含全部 文件:行号 引用与对标机制出处）保留在本次五路深研报告中；实施任一项时建议先重读对应维度的源码现状段落。
