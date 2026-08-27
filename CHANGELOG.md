# 更新日志

格式：版本（日期）+ 变更要点。`reqbank changelog [版本]` 查看指定版本；不接参数显示最新。

## 0.19.0（2026-08-27）

**新增 Kimi Code 适配器 + payload 归一兼容 `tool_input.path`**

- **Kimi Code 适配器（`engine/kimi-hook.mjs`）**：`--agents kimi` 或自动探测（`~/.kimi-code` 存在）启用。Kimi 只有用户级钩子，init 往 `~/.kimi-code/config.toml` 写入带 `reqbank-harness-hooks` 标记的全局块——命令自带 `.harness` 存在守卫（未初始化的项目静默跳过）、幂等替换、写前 `.bak` 备份；`HARNESS_KIMI_CONFIG` 可覆盖目标路径（测试用）。协议差异由适配器吸收：
  - SessionStart / UserPromptSubmit：引擎 `hookSpecificOutput.additionalContext` 解包为纯文本 stdout（Kimi 只把纯文本追加进上下文）；
  - PreToolUse：pre-critic 的 `permissionDecision` JSON 原样直通（Kimi 原生支持）；
  - PostToolUse：Kimi 侧 observation-only，critic 的 `[reqbank 自动沉淀]` 提醒无法直达模型——暂存 `.agentdoc/harness/kimi-pending-nudge.md`（init 自动加入 .gitignore），下次 UserPromptSubmit 随召回注入并清空，补回提醒通道；
  - Stop：引擎 `decision:"block"` 翻译为 Kimi 的 exit 2 + stderr reason。
- **payload 归一**：`normalizeClaudeCodeEdit` 新增 `tool_input.path` 兜底（Kimi 的 Edit/Write 参数名，语义同 Claude 的 `file_path`）——此前 Kimi 会话的文件路径提取恒为空，critic 召回与沉淀提醒静默失效。
- eval/p3p4 新增 KIMI-PATH、KIMI-ADP-* 六条回归；eval/update-changelog 新增 KIMI-INIT 三条回归（标记块幂等 / 备份 / gitignore）。

## 0.18.0（2026-08-27）

**修正沉淀提醒粒度 + 模块候选自动起草（P6）——回应「库空不沉淀、多文件失明」两个实测问题**

- 沉淀提醒按文件去重：critic 的 `[reqbank 自动沉淀]` 提示原为「同回合只提醒一次」，多文件回合只有首个文件有提示、其余全部静默。改为按文件去重——同回合每个未提醒过的新文件独立提示，重复编辑同一文件不重复打扰（去重依据 learning-log 同回合同名事件的 `recall_path_candidates`）。实测：同回合 3 文件 2 弹 1 抑制、新回合恢复提醒。
- 模块候选自动起草：Stop 沉淀层（`engine/lib/distill.mjs` 新增 `writeModuleDrafts`）把本回合零覆盖的真实改动按目录聚合成 `inbox/module-drafts/<slug>.md` 模块草稿——含累计证据文件、按证据父目录生成的建议命中路径（`[strong]` + 自动标签）、四步激活指引；跨回合增量累积、整体重写幂等、同名模块已注册时跳过。此前库空时只能靠人工考古起草，现在证据链自动备好，人审激活从「考古项目」降为「裁剪确认」。
- 边界不变：只写 `inbox/` 永不写 `modules/`（人审先于入库）；草稿激活前不参与召回；fail-open，不参与 block 判定。learning-log 新增 `distill_module_drafts` 审计字段。
- agent-guide 增补「自动化行为（0.18.0 起）」章节；旧行为（每回合一次）的 DNUDGE-ONCE 语义由本版起作废。

## 0.17.0（2026-08-27）

**新增：零覆盖编辑的沉淀提醒——由当次会话 agent 自起草契约候选**

- 流程纠偏：需求提取不该卡外部 LLM key——正在改代码的会话本身有完整上下文。critic 在「零召回且无断言命中」编辑后（原静默 skip 分支）注入一次性 PostToolUse additionalContext，提示当前 agent 收尾前按 agent-guide 五步协议向 `inbox/stop-<日期>.md` 追加 `[ai-draft]` 人审草稿卡；同回合只提醒一次。
- 元路径（`.harness/`、`.agentdoc/`、AGENTS.md 等）不算沉淀素材，isBusinessFile 过滤。
- 行为兼容：`skip_reason` 保持 `no_strong_recall`，除一次上下文注入外默认行为不变。eval/p3p4 新增 DNUDGE / DNUDGE-ONCE 回归。

## 0.16.0（2026-08-27）

**新增：Stop 自动沉淀（P5）——补上「运行中入金」通道**

- 钩子链（pre-critic / critic / finalize）此前只消费既有条款：库为空时召回空转，store 永不增长，沉淀全靠手动 mine / reflect。本版给 Stop 钩子新增自动沉淀层 `engine/lib/distill.mjs`：
  - 确定性层（始终启用）：终态裁决循环顺带收集「改动但零召回且无断言命中」的业务文件（零额外 IO），落成 `inbox/stop-<日期>.md` 草稿卡，同日同名去重；
  - LLM 起草层（默认关闭，`HARNESS_STOP_DISTILL=1`）：复用 llm-critic 的 provider 探测 / 超时 / fail-open 约定，把 diff 摘要起草为「不得」句式 REQ 候选。
- 边界不变：只写 `inbox/` 永不写 `modules/`（人审先于入库）；不参与 block 判定，异常 fail-open 不改变放行/拦截语义；learning-log 新增 `distill_deterministic_cards` / `distill_llm_drafts` / `distill_llm_enabled` / `distill_skipped_reason` 四个审计字段。
- eval/p3p4 新增 DISTILL / DISTILL-DUP / DISTILL-CFG 回归。
- 修复 smoke 测试隔离：`isolatedEnv` 补剥 `ZCODE_APP_VERSION`——0.14.0 引入 zcode 自动探测后，在 ZCode 客户端终端内跑套件会让 bare init 误探测为 zcode（exit 0），违背"探测测试不随宿主环境漂移"的本意。

## 0.15.2（2026-08-26）

**修复：Windows 下 _template 误报**

- `engine/lib/harness-store.mjs` 的 `_template` 过滤用 `path.endsWith('/_template')`，在 Windows（`\` 分隔）失效，`.agentdoc/harness/modules/_template` 被当成真实模块，触发 `check` 的 `B9` 漂移与 `dead-path` 警告。改为 `basename(path.replace(/\\/g, '/'))` 跨平台判定，`check` 在 Windows 亦静默通过。

## 0.15.1（2026-08-26）

**修复：Windows 下 check/version 的 ESM 盘符路径错误（Received protocol 'd:'）**

- CLI（bin/harness.mjs）六处动态 `import(绝对路径)` 在 Windows 抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`——ESM specifier 按 URL 解析，盘符 `D:\…` 被当成协议。新增 `dynamicImport()`（`pathToFileURL` 转换，落在 engine/lib/repo-paths.mjs）统一替换。
- 0.15.0 修复后的钩子链路（相对路径命令）在 Windows 已实测 exit 0；本版补齐维护命令（check / version / confirm / --vendor / lang）。
- p2 新增 I-URL 回归：盘符路径经修复后报 `ERR_MODULE_NOT_FOUND`（正常缺失）而非 URL 协议错误——跨平台可测（URL 解析与平台无关）。

## 0.15.0（2026-08-26）

**钩子命令免 shell 特性：Windows 任意 shell 可用**

- claude / codex 适配器的钩子命令从 `node "$(git rev-parse --show-toplevel)/…"` 改为相对路径 `node .harness/engine/<hook>.mjs`（依赖钩子运行时 cwd = 项目根——三家客户端的约定行为）。
- 修复场景（Windows 真实复现）：从 cmd/PowerShell 启动的 agent 里 `$(...)` 空展开，node 收到 `/.harness/engine/x.mjs` → MODULE_NOT_FOUND → 钩子 exit 1，且引擎零日志（学习日志无痕迹即此特征）。v0.14.x 需从 Git Bash 启动客户端规避。
- p2 新增 I-PORT 可移植性不变量：渲染产物所有钩子命令不得含 `$(`、必须相对路径。
- ZCode 适配器不受影响（`${ZCODE_PROJECT_DIR}` 由客户端展开，本就无 shell 依赖）。

## 0.14.1（2026-08-26）

**修复：模板注释行被清单解析器误当登记项**

- 官方模板在各清单节内留有 `<!-- 格式：… -->` 提示注释，三个解析器均未跳过：①「已建模块」把注释解析成幽灵模块名，触发 B9 漂移误报（`check`/`doctor` 输出噪音）；②「待初始化高风险模块」把注释静默解析成幽灵待初始化项；③「断言」节内的注释被报 assertion-format 格式违规。现统一跳过 `<!--` 开头的行。
- 根因是回归夹具全部手写 index.md（无注释行），从未测过官方模板原貌；p1 新增 T0b 用模板注释行直测三个解析器（无幽灵模块、无 B9 误报）。

## 0.14.0（2026-08-26）

**ZCode 适配器：官方支持第三家 agent 客户端**

- `init --agents zcode`（自动探测：`ZCODE_APP_VERSION` 环境线索 / `.zcode/` 目录）渲染 `.zcode/config.json`：`hooks.events` 结构 + `enabled:true`，命令用 `${ZCODE_PROJECT_DIR}` 模板变量，写前留 `.bak`。
- payload 归一层新增 ZCode `turnId` fallback：ZCode 实测 payload 与 Claude Code 契约兼容（snake_case 双发），唯 `turn_id` 只有 camelCase `turnId`——归一后 learning-log 可按回合归组。真实采集的 payload 已固化为回归夹具（p0-Z1）。
- 实测行为写进文档（README 能力矩阵 + llms.txt）：首次使用客户端弹钩子审核，**全选信任一次**即持续生效且即时生效无需重启；勿与用户级 `~/.zcode/cli/config.json` 双注册（实测事件双跑）；仓库若忽略 `.zcode/` 整目录，需 `.zcode/*` + `!.zcode/config.json` 两行才能随仓库分发。
- coverage-100 新增 A07（zcode 适配器形状断言）。

## 0.13.1（2026-08-26）

**修复 CLI 派发：mine/reflect 自 v0.9.0 起静默降级为 status 报表**

- `reqbank mine` / `reqbank reflect` 的 dispatch 误将两个命令连同 `status` 一并派发到 `engine/status.mjs`——CLI 层从未到达考古/回流引擎（既有测试直接调 engine 入口，未覆盖 CLI 层）。现按命令映射派发到 `mine.mjs` / `reflect.mjs`，usage 串同步补全。
- `engine/reflect.mjs` 的 `main` 非 async：成功路径也以退出码 1 崩溃（`main().catch` 对 undefined 取 catch 抛 TypeError），fail-open 形同虚设。对齐 mine.mjs 改为 async。
- 对抗评测新增 ② 段 DISPATCH-MINE / DISPATCH-REFLECT：受控仓库走 CLI 入口，断言 stderr 引擎标记 + stdout 无 status 报表，封住「只测 engine 不测 CLI」盲区。

## 0.13.0（2026-08-25）

**执法闭合（硬拦只认断言，补四条引擎洞）**

- 路径召回为空仍扫描断言池：未登记路径删守卫 token 也会硬拦；无断言命中才记 `no_strong_recall`。
- 未 `git add` 的新业务文件：gate / Stop 合成新增 diff，不再空 diff 漏拦。
- `reqbank-ignore` 与 `:warn` 在 PreToolUse / critic / Stop / gate 四层同口径（降级不硬拦，且 counted）。
- Stop 终态：analysis 回合也对照 HEAD 审当前脏文件；无 UserPromptSubmit 事件仍不扫全库（未知 turn_id 不误伤）。

## 0.12.1（2026-08-25）

**断言假阳性**

- `forbid-call` / `no-negate` 跳过整行注释（含 Javadoc 续行）；残缺调用片段仍字符串回退拦截。
- `no-delete` 忽略「同一行只加行尾 `//` 注释」。真删除、极性改写、换成别的标识符仍拦。
- 已知顶板（本版不修）：未 `git add` 的新文件 gate 空 diff、方法引用/反射、只改 XML/白名单/资源映射、无断言的 AGENTS 长文。硬拦仍只认已编译断言。

## 0.12.0（2026-08-25）

**硬拦只认断言**

- Stop / gate / critic critical **只认「## 断言」命中**。无断言的「不得…」条款不再经 n-gram 或标点翻转升 conflict、不硬拦、不占 L0 禁止类正文。
- LLM critic 改为纯审计（记录 violations，不升级 critical）。
- `check` 的 compile-weak 提示改为：无断言不算存款。

## 0.11.0（2026-08-24）

**版本体验：升级提醒 + 版本说明**

- **升级提醒**：SessionStart 自动检查 npm registry 新版本（24h 本地缓存，每会话最多一次网络请求；离线/CI 静默 fail-open；`HARNESS_SKIP_UPDATE_CHECK=1` 彻底关闭）。有新版时注入一行提醒：`[reqbank] 新版本可用：x.y.z → a.b.c`。`reqbank version` 同时显示已装与 latest。
- **版本说明**：本文件随包分发（`.harness/CHANGELOG.md`）；新增 `reqbank changelog [版本]` 命令查看对应版本变更；`reqbank update` 升级完成后打印新版变更摘要。
- 缓存文件 `.agentdoc/harness/update-check.json` 已加入 init 的 .gitignore 运行产物清单。

## 0.10.1（2026-08-24）

**真实项目验收修复**（bpms/frontend 真实代码库验收 13/13 用例暴露的缺陷，详见 `eval/acceptance-p5.mjs`）

- 修复成员式 pattern（`message.error`）的 AST 确认错位：确认逻辑两侧对齐（pattern 尾段 ↔ 调用尾段），此前真实调用会被错误推翻为未命中。
- **断言层改为全库扫描**：此前断言只跑路径召回集——forbid-call 挂在 request 模块条款时，hooks 模块文件的违规调用因召回不到而完全绕过。现在断言池 = 召回集 ∪ 全部带断言条款（闭集规则预筛廉价），n-gram 语义分类仍限召回域。
- 修复池化引入的 gate 性能回退（3.3s → 2.2s）：断言承载条款加载提到文件循环外。
- 同一取反翻转四层全拦验证通过（pre-critic deny / critic critical / gate exit 1 / Stop block）；注释提及与合法 `antdMessage.error` 通道零误报。

## 0.10.0（2026-08-24）

**P5 语义检测升级：标点翻转判定 + tree-sitter WASM 结构化断言**

- **L1 标点感知（全语言，零依赖）**：`detectBooleanFlip` 从原始 diff 提取布尔三元组，同操作数下 `&&`↔`||` 或裸/取反互换判确定性 conflict；操作数交换等价改写不误报。对抗用例 ATK-FLIP 从"已知盲区"翻转为"已拦截"。
- **L2 tree-sitter WASM（~800KB vendor，零 npm 运行时依赖）**：web-tree-sitter 运行时 + JS/TS/TSX/Java/Python/Go/Rust 七语法包（brotli 压缩、按后缀懒加载、字符串预筛不命中零解析成本、片段用完即弃）。断言新增 `forbid-call`（AST 确认调用点，注释/字符串提及不误报）与 `no-negate`（守卫取反 `!x` / `not x`）；无语法包语言退回字符串层照拦。
- 新增 `reqbank lang add/list/remove`：按需下载语法包到 `.agentdoc/harness/vendor-lang/`（随仓库共享）；`reqbank check --vendor` 校验 vendor 资产完整性（sha256 对照 VENDOR.json）。
- 新增回归套件 `eval/p5-ast.mjs`（19 用例）接入 CI；六套件 104 用例 + coverage-100 108 用例全绿。

## 0.9.0（2026-08-24）

**首个完整里程碑：P0-P4 全量落地**

- **P0 正确性止血**：ID 上限/段名漂移/verify 日志/重复 ID/cache 断言（B1/B2/B3/B8）。
- **P1 执法无洞、召回可信**：Stop 终态裁决（不信过程信终态，修 B7"先脏后净"绕过）、trace-integrity、注入预算 + L0 禁止类直注分层、critic req-only 去污染（B9）。
- **P2 条款可执行化 + CI 同源**：`## 断言` 节（no-delete/forbid-add/forbid-path）、PreToolUse 写前 deny、`reqbank gate`（dirty/staged/--base 三模式 + --freeze 基线）+ `init --gate`、LLM critic 四字段结构化复核。
- **P3 银行账目**：索引第 5 列生命周期与置信度（active/draft/superseded、confirmed/inferred/gap、:warn 降级档）、`reqbank status` 日志派生、漂移检测、report 2.0（req_matrix/修复率/召回闭环/死规则 + 快照棘轮）。
- **P4 考古入金**：`reqbank mine`（instruction/git-fix/todo/hotspot 四源考古 → inbox 人审入库）、`reqbank reflect`（重复冲突聚合回流，修 B4 transcript 接线）、缓存索引、日志轮转、`HARNESS_STOP_VERIFY=1` Stop 自动跑命中 TC。
- 自验证仓库：五个回归套件 + 对抗评测 + coverage-100（bpms 真实前端 108 用例）+ CI（ubuntu/windows 双平台）。
