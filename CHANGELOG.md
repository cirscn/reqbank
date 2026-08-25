# 更新日志

格式：版本（日期）+ 变更要点。`reqbank changelog [版本]` 查看指定版本；不接参数显示最新。

## 0.12.0（2026-08-24）

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
