# @cirscn/reqbank

**reqbank — AI 编码代理的需求银行** —— 把项目里"必须遵守的业务契约"沉淀为带标签的 REQ/TC 条目，通过生命周期钩子在每个回合自动召回注入，确定性冲突在收尾时拦截。

纯 Node（无三方依赖）+ 纯 Markdown 真源。不绑定任何单一 AI 工具。

![npm](https://img.shields.io/npm/v/@cirscn/reqbank) ![node](https://img.shields.io/node/v/@cirscn/reqbank) ![license](https://img.shields.io/npm/l/@cirscn/reqbank)

## 它解决什么

| 没有 reqbank | 有 reqbank |
|---|---|
| 需求散落在对话里，新会话即失忆 | 契约落盘为 REQ 条目，每回合自动召回注入 |
| AI 改了行为，没人知道违反了哪条规则 | PostToolUse critic 将 diff 对照条款分类冲突 |
| 文档写完三周就烂 | 双 lint + TC 执行器 + 度量报表保持新鲜 |

## 安装

```bash
cd your-repo
npx @cirscn/reqbank init --agents codex,claude   # 首次安装（引擎 + 脚手架 + 钩子注册）
```

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
## 索引

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
| `reqbank init --agents codex,claude` | 初始化脚手架 + 渲染 agent 适配器 |
| `reqbank scope "<任务>"` | 任务 → REQ/TC 证据链（JSONL） |
| `reqbank check [--strict]` | 结构完整性 + 标签覆盖 lint + 矛盾条款 lint |
| `reqbank verify [--tc <id>]` | 执行命中 TC 的验证命令（"命中即测"机械化） |
| `reqbank report [--days 7] [--json]` | 召回命中率 / 冲突分布 / 阻断趋势 |
| `reqbank impact <file...>` | 基于 `.mex/graph.db` 的调用邻居影响面 |
| `reqbank update` | 升级引擎（npm registry，`--git` 走远端） |
| `reqbank smoke` / `version` / `doctor` | 自检 / 版本 / 健康诊断 |

## 可选增强层

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
- 钩子命令使用 POSIX 子命令替换，需要 bash 环境（Claude Code / Codex 的 Windows 版本本就依赖 Git Bash）；纯 cmd/PowerShell 暂不支持。
- `install.sh` 需要 Git Bash 或 WSL。

## 各 Agent 的钩子能力矩阵

引擎只有一套，但各工具协议能力不同，**执法强度因 agent 而异**：

| Agent | 注册位置 | 回合召回注入 | 编辑后 critic | Stop 硬拦截 | 已知边界 |
|---|---|---|---|---|---|
| Claude Code | `.claude/settings.json` | ✅ additionalContext 强制推送 | ✅ 分类+注入+审计 | ✅ `decision:block` | Windows 需 Git Bash |
| Codex CLI | `.codex/hooks.json` | ✅ 同上 | ✅ 同上 | ✅ 兼容两种 block 形状 | 多层配置全部加载：包内会话由包内 hooks 独占，根桥自动 fail-open 让位 |
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
| 综合清单 | [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | Memory & Context Persistence 专区季度巡检 |

巡检节奏建议：每季度扫一轮上表 release/changelog；出现"条文级执法"同类实现时优先评估吸收。

## License

MIT
