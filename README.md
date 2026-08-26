# @cirscn/reqbank

**reqbank — AI 编码代理的需求银行** —— 把项目里"必须遵守的业务契约"沉淀为带标签的 REQ/TC 条目，通过生命周期钩子在每个回合自动召回注入，确定性冲突在收尾时拦截。

纯 Node（无三方依赖）+ 纯 Markdown 真源。不绑定任何单一 AI 工具。

> 🤖 给 agent 的浓缩参考见 [llms.txt](llms.txt)——事实密度优先，命令可直接执行。

![npm](https://img.shields.io/npm/v/@cirscn/reqbank) ![node](https://img.shields.io/node/v/@cirscn/reqbank) ![license](https://img.shields.io/npm/l/@cirscn/reqbank)

## 它解决什么

| 没有 reqbank | 有 reqbank |
|---|---|
| 需求散落在对话里，新会话即失忆 | 契约落盘为 REQ 条目，每回合自动召回注入 |
| AI 改了行为，没人知道违反了哪条规则 | PostToolUse critic 将 diff 对照条款分类冲突 |
| 文档写完三周就烂 | 双 lint + TC 执行器 + 度量报表保持新鲜 |

## 安装

### 方式一：让 Agent 替你装（推荐）

复制下方指令，直接发给你的 AI 编码助手（Claude Code / Codex 等）：

> 在当前仓库运行 `npx @cirscn/reqbank init`——它会自动探测已配置的 agent，探测不到会明确报错，届时再问我用哪个工具。退出码 0 且输出含 `✓ check passed` 即安装成功。装完提醒我：钩子从下一个会话开始生效；建议提交 `.harness/`、`.agentdoc/` 与适配器配置。
>
> 安装完成后，你的每个会话都会自动召回我沉淀的需求契约（REQ/TC），改动违反契约时收尾拦截。

### 方式二：手动安装

```bash
cd your-repo
npx @cirscn/reqbank init    # --agents 可省略：自动探测（CLAUDECODE/ZCODE_APP_VERSION 环境线索、.claude/、.codex/、.zcode/ 目录）
```

仓库已有 `.claude/settings.json` 时自动合并钩子条目（原内容原样保留，写前留 `.bak` 备份），仅当该文件无法解析才回退为片段文件待手动合并。init 末尾自动运行 `check`，输出 `✓ check passed` 即安装成功；钩子自新会话起生效。

**ZCode 用户**：适配器写入 `.zcode/config.json`（`hooks.events` 结构 + `enabled:true`，命令用 `${ZCODE_PROJECT_DIR}` 模板变量）。首次使用时客户端会弹出钩子审核——**全选后信任一次**即持续生效（逐条信任会反复弹出）。两个注意：① 仓库若已忽略 `.zcode/` 整目录，想随仓库分发需改为 `.zcode/*` + `!.zcode/config.json` 两行（git 无法重新包含被排除目录内的文件）；② 不要再在用户级 `~/.zcode/cli/config.json` 注册同一引擎——双注册会导致每个事件双跑。ZCode 的 payload 与 Claude Code 契约兼容（snake_case 双发），唯 `turn_id` 只有 camelCase `turnId`，引擎已在 payload 归一层做 fallback。

安装产物：

```
<repo>/
├── .harness/                  ← 引擎 + CLI（提交进 git，协作者开箱即用）
│   ├── bin/harness.mjs        命令行入口
│   └── engine/                四钩子 + 召回/分类/lint 引擎
└── .agentdoc/harness/         ← 需求真源（纯 Markdown）
    ├── index.md               路径/glob [strong|weak] → 标签 的召回索引
    ├── global/                跨模块契约
    └── modules/<模块>/        index.md + requirements.md + tests.md
```

init 会向 `.gitignore` 幂等追加运行产物忽略（已存在则跳过）：`hook-payloads/`、`learning-log.jsonl`，选装 claude 时另加 `.claude/settings.local.json`（Claude Code 个人权限白名单，按约定不进库）。`.agentdoc` 真源文档不受影响，照常提交。

## 使用闭环

### 1. 沉淀需求

```bash
reqbank init    # 已由安装完成；之后按需建模块目录
```

`.agentdoc/harness/modules/passport-preview/requirements.md`：

```markdown
## 索引

REQ-001 | address-mapping | TC-001 | 制造地址与邮寄地址相互独立

## 需求澄清

REQ-001: 制造地址真源字段是 manufacturerAddress；邮寄地址不得回退读取制造地址——
两个地址在数据层即相互独立，任何兜底都属于违反契约。
```

同目录 `tests.md`：

```markdown
## 内容索引

TC-001 | address-mapping | REQ-001 | 地址独立性验证

## 测试用例

TC-001: G=数据同时含两类地址。 | W=修改地址映射逻辑。 | E=邮寄地址缺失时不回退制造地址。 | V=跑 `pnpm vitest run src/.../preview.test.tsx`
```

模块 `index.md` 登记召回根：

```markdown
## 命中路径

- `src/apps/portal/pages/PublicPassportPreviewPage.tsx` [strong] | address-mapping,preview
```

**三条铁律**：① 写"不得做什么"，不只写理想路径；② 每条 REQ 必须挂可执行的 TC；③ REQ 标签必须出现在路径行的标签里，否则召回不可达（check 会报错）。

### 2. 检索

```bash
reqbank scope "修复 useFetch 的错误提示去重问题"
# JSONL 证据链：命中条款 + 澄清正文 + 关联 TC + 验证命令
```

### 3. 让钩子接管

会话中：`UserPromptSubmit` 注入 ID-first 召回摘要；编辑后 critic 按 diff 对照条款；收尾时 Stop 只拦截确定性冲突。

## CLI 命令

| 命令 | 作用 |
|---|---|
| `reqbank init --agents codex,claude` | 初始化脚手架 + 渲染 agent 适配器；`--gate` 追加装配 pre-commit 钩子与 CI workflow |
| `reqbank scope "<任务>"` | 任务 → REQ/TC 证据链（JSONL） |
| `reqbank check [--strict]` | 结构完整性 + 标签覆盖 + 矛盾/追溯完整性/生命周期/漂移 lint |
| `reqbank verify [--tc <id>] [--all]` | 执行命中 TC 的验证命令（"命中即测"机械化）；`--all` 全库枚举（CI）；破坏性命令确定性拒绝 |
| `reqbank gate [--staged\|--base <ref>] [--freeze] [--json]` | CI/pre-commit 判决入口——与钩子同源判定链，exit 1=确定性冲突；`--freeze` 冻结存量（棘轮） |
| `reqbank status [--stale-days 30] [--json]` | 条款验证状态三态派生（verified/unproven/stale/violated），从日志重算不写回真源 |
| `reqbank confirm <scope:REQ-id>` | 人审升级置信度 inferred/gap → confirmed（写索引第 5 列，幂等） |
| `reqbank mine [--limit 20]` | 冷启动考古：instruction/git-fix/todo/hotspot 四源候选 → inbox/ 草稿区（永不直写 modules/） |
| `reqbank reflect [--transcript <path>]` | 违规回流：重复冲突/零召回路径/会话纠错 → 条款建议写 inbox/ |
| `reqbank report [--days 7] [--json] [--snapshot [--check]]` | 召回命中率/冲突分布/REQ 终态矩阵/整改率/召回质量；`--snapshot` 快照棘轮（度量即门禁） |
| `reqbank impact <file...>` | 基于 `.mex/graph.db` 的调用邻居影响面 |
| `reqbank update` | 升级引擎（npm registry，`--git` 走远端） |
| `reqbank smoke` / `version` / `doctor` | 自检 / 版本 / 健康诊断 |

## 可选增强层

### 条款断言层（把"不得"编译成机器可判规则）

requirements.md 的 `## 断言` 节才是存款：`REQ-001 | no-delete|forbid-add|forbid-path|forbid-call|no-negate | <pattern>`。硬拦（PreToolUse deny / Stop block / `gate` exit 1）**只认断言命中**；只有「不得…」空话的条款不拦截、不占禁止类正文。`no-delete` 抓守卫被删、`forbid-add`/`forbid-call` 捕获新增式违反、`forbid-path` 保护敏感路径、`no-negate` 拦守卫取反。`reqbank check` 对含禁止语义却无断言的条款给 compile-weak 提示。

### 语法感知层（P5：标点翻转 + tree-sitter WASM）

- **标点翻转判定（全语言，零依赖）**：`user && active` 被改成 `!user || active` 这类极性/连接符翻转是 n-gram 的结构性盲区——token 集完全对称。引擎现从原始 diff 提取布尔三元组，同操作数下 `&&↔||` 或裸/取反互换即判确定性 conflict（操作数交换等价改写不误报）。
- **结构化断言（JS/TS/TSX/Java/Python/Go/Rust）**：`forbid-call` 只拦 AST 确认的真实调用点——注释和字符串里的提及不误报；`no-negate` 拦截守卫标识符被取反（`!x` / `not x`）。断言层**全库扫描**（召回集 ∪ 全部带断言条款）：路径召回为空仍跑断言池，A 模块条款对未登记路径上的违规同样硬拦；n-gram 语义分类仍限于召回域。gate / Stop 对未 `git add` 的新业务文件合成新增 diff。实现为 vendored tree-sitter WASM（~800KB 静态资产，brotli 压缩语法包懒加载，零 npm 运行时依赖，Node 22 内置 WASM 引擎全平台）。字符串预筛不命中的回合零解析成本；无语法包语言退回字符串层照拦。`reqbank check --vendor` 校验资产完整性（sha256 对照 `engine/vendor/tree-sitter/VENDOR.json`）。
- **语言扩展**：`reqbank lang add kotlin --ext .kt` 按需下载语法包到 `.agentdoc/harness/vendor-lang/`（随仓库共享给协作者）；`lang list` / `lang remove` 管理。YAML/JSON/HTML/CSS 等声明式配置明确不做 AST——字符串断言层即正确工具。

### 升级提醒与版本说明

SessionStart 自动检查 npm 新版本：24h 本地缓存（每会话最多一次网络请求），离线/CI 静默失败不影响会话，`HARNESS_SKIP_UPDATE_CHECK=1` 彻底关闭。有新版时注入一行提醒，`reqbank version` 同步显示已装与 latest。`reqbank changelog [版本]` 查看版本变更（不接参数显示最新，`--all` 全量）；`reqbank update` 升级完成后打印新版变更摘要。CHANGELOG.md 随包分发到 `.harness/CHANGELOG.md`。

### 条款生命周期与置信度（索引第 5 列）

索引行可选第 5 列：`REQ-001 | tags | TC-001 | active:confirmed | 标题`——状态 `active|draft|superseded>REQ-x`、置信度 `confirmed|inferred|gap`、执法档 `:warn`（conflict 降级不硬拦）。非 active 条目不参与召回/执法；`reqbank confirm` 人审升级；`reqbank status` 从日志派生验证三态。误报可内联抑制：diff 中 `reqbank-ignore: <scope:id>`（必须可见可数）。`:warn` 与 `reqbank-ignore` 在 PreToolUse / critic / Stop / gate 四层同口径。Stop 对 analysis 回合也对照 HEAD 审盘上脏文件。

### Stop 自动验证命中 TC（`HARNESS_STOP_VERIFY=1`）

开启后收尾时对冲突条款真跑其 TC：TC 失败 → block 引用 TC id；可执行 TC 全过 → 冲突降级放行（守卫消失但测试绿，交人工确认）。危险命令确定性拒绝。

### LLM critic（捕获新增式违反禁止类需求）

确定性分类器的盲区：纯新增代码实施某条"不得/禁止"条款的行为。配置后由 LLM 对候选条款做极性判定：

```bash
export HARNESS_LLM_CRITIC=1
export ANTHROPIC_API_KEY=sk-...     # 或 OPENAI_API_KEY（兼容自定义 OPENAI_BASE_URL）
# 可选：HARNESS_LLM_MODEL、HARNESS_LLM_TIMEOUT_MS、HARNESS_LLM_MAX_RECORDS
```

无 key / 超时 / 解析失败一律 fail-open 静默降级，不影响主流程。

### 结构影响面（跨文件执法）

存在 `.mex/graph.db`（[mex](https://github.com/mex-memory/mex) 图谱）时自动启用：改动共享 util 会把调用邻居所在模块的 REQ 一并召回。`HARNESS_IMPACT=off` 关闭。

## 升级

```bash
reqbank update        # 从 npm registry 拉最新引擎（默认）
reqbank update --git  # 或走 git 远端（HARNESS_KIT_URL 可覆盖）
```

只替换 `.harness/engine|bin|templates`，**绝不触碰 `.agentdoc/harness/` 真源**——你的需求记忆永远在你手里。

维护者发布新版本：见 [RELEASE.md](RELEASE.md)（tag 驱动，CI 自动完成）。

## Monorepo（多包仓库）

两种姿势：

- **按包安装（推荐）**：进入目标包目录执行 `npx @cirscn/reqbank init`，每个包独立 `.harness/` + `.agentdoc/harness/`，互不串扰。
- **仓根单实例**：根目录安装后，各包契约写入同一份 harness，用命中路径区分（`packages/a/src/**`、`packages/b/src/**`）。

进阶的"仓根桥接到包内引擎"模式（Grok/Codex 双入口、fail-open 让位）参见 `engine/bridge-from-workspace.mjs` 头部注释。

## Windows 说明

- 引擎为纯 Node ESM，Windows 原生可跑（Node ≥ 22.5）。
- v0.15.0 起 claude / codex 适配器的钩子命令为相对路径（`node .harness/engine/<hook>.mjs`，依赖钩子运行时 cwd = 项目根，三家客户端均如此），不含 POSIX 子命令替换——**cmd / PowerShell / Git Bash 任意 shell 启动均可用**，不再强制 Git Bash。ZCode 适配器用客户端展开的 `${ZCODE_PROJECT_DIR}` 模板变量，同样无 shell 依赖。
- 前提：钩子命令需在项目根执行（客户端约定行为）；若你的 agent 以其他 cwd 调起钩子导致 MODULE_NOT_FOUND，属于客户端配置问题，可用 `--agents` 重渲染或反馈 issue。

## 各 Agent 的钩子能力矩阵

引擎只有一套，但各工具协议能力不同，**执法强度因 agent 而异**：

| Agent | 注册位置 | 回合召回注入 | 写前拦截 | 编辑后 critic | Stop 硬拦截 | 已知边界 |
|---|---|---|---|---|---|---|
| Claude Code | `.claude/settings.json` | ✅ additionalContext 强制推送 | ✅ PreToolUse deny（断言层，Edit/Write/MultiEdit） | ✅ 分类+注入+审计 | ✅ `decision:block` | Windows 需 Git Bash |
| ZCode | `.zcode/config.json` | ✅ 同上 | ✅ 同上（含 matcher） | ✅ 同上 | ✅ | 首次需客户端审核全选信任一次；payload 兼容 CC（turnId 引擎归一）；勿与用户级 hooks 双注册 |
| Codex CLI | `.codex/hooks.json` | ✅ 同上 | ❌ 协议无 PreToolUse 事件 | ✅ 同上 | ✅ 兼容两种 block 形状 | 多层配置全部加载：包内会话由包内 hooks 独占，根桥自动 fail-open 让位 |
| Grok | `.grok/hooks` + rules 文件中继 | ⚠️ 写入 rules 文件，agent 同回合手读 | ⚠️ 仅审计日志 | ❌ 协议不允许 | 被动钩子 stdout 被忽略；多会话 rules 文件 last-writer-wins |
| 无钩子工具（Cursor 等） | 仅 AGENTS.md 指令 | ❌ 手动 `reqbank scope` | ❌ | ❌ | 建议配合 CI 门禁补偿 |

设计含义：同一仓库多 agent 共享真源与引擎；Grok 是降级观察模式；无钩子工具把 `scope` 写进规则文件作开工第一步并用 CI 补拦截。新增适配器只需实现四件事：事件注册格式、payload 归一、上下文回写通道、Stop 阻断语义。

## 参考生态（持续学习清单）

| 层 | 项目 | 值得学什么 |
|---|---|---|
| 活知识文档 | [mex-memory/mex](https://github.com/mex-memory/mex) | agent 自维护 wiki、anchor→ROUTER 路由、check/sync 修复回路 |
| 结构图谱 | [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | 极速索引、影响面分析、MCP 工具面设计 |
| 规格演进 | [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) | 增量规格 ADDED/MODIFIED/REMOVED 与归档机制 |
| 结构漂移 | [clay-good/OpenLore](https://github.com/clay-good/OpenLore) | spec↔文件映射漂移检测、CI 门禁 |
| 流程 SDD | [github/spec-kit](https://github.com/github/spec-kit)、[obra/superpowers](https://github.com/obra/superpowers)、[bmad-code-org/BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) | 反面教材为主：流程仪式的边界在哪 |
| 会话记忆 | [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)、[mem0ai/mem0](https://github.com/mem0ai/mem0) | 过程记忆与需求记忆的边界 |
| 契约执法 | [mesa-dot-dev/saguaro](https://github.com/mesa-dot-dev/saguaro) | 机制同构镜像（规则 md + frontmatter、PreToolUse 注入、Stop 审 diff）；盯其向业务契约语义的演化 |
| 可验证契约 | [ZhangHanDong/agent-spec](https://github.com/ZhangHanDong/agent-spec) | trace 三态追溯（honored/violated/unproven）、全确定性 gate、EARS/ISO-29148 lint |
| 条款验证 | [av/facts](https://github.com/av/facts) | 条款内联可执行验证命令 + 生命周期标签的极简形态 |
| 政策执法 | [eqtylab/cupcake](https://github.com/eqtylab/cupcake) | Rego→Wasm 五态判决（Allow/Modify/Block/Warn/Require-Review）、多 agent 适配的工程化 |
| 钩子纪律 | [pdewost/coding-constitution](https://github.com/pdewost/coding-constitution) | ANCHOR/GUARDRAIL/COMPILE-GATE/CLOSEOUT-GATE 与本引擎钩子布阵的对照 |
| 追溯正统 | [awslabs/duvet](https://github.com/awslabs/duvet) | 注释级 spec↔实现↔测试双向追溯、测试执行/覆盖数据关联 |
| 综合清单 | [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | Memory & Context Persistence 专区季度巡检 |

巡检节奏建议：每季度扫一轮上表 release/changelog；出现"条文级执法"同类实现时优先评估吸收。完整竞品扫描（2026-08 四路检索，含 saguaro / moai-adk / FredAntB-SDD 等直接竞品与战略启示）见 [docs/competitive-research-2026-08.md](docs/competitive-research-2026-08.md)。

## License

MIT
