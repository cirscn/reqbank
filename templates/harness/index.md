# Harness 索引

先用本文件识别全局与模块命中范围，再读取对应文件；不要全量读取所有模块。

## 读取

1. 按改动路径匹配模块。
2. 按任务语义补充标签。
3. 始终读 `global/index.md`；命中模块时再读模块 `index.md`，用标签召回需求和测试。
4. 未命中已建模块不注入、不手写固定模板；若形成长期记忆、存在验证缺口或命中待初始化高风险模块，才简短说明新增 / 不沉淀原因。

## 全局入口

global-index | .agentdoc/harness/global/index.md
global-requirements | .agentdoc/harness/global/requirements.md
global-tests | .agentdoc/harness/global/tests.md

## 已建模块

<!-- 格式：模块名 | .agentdoc/harness/modules/<name>/ | 标签a,标签b -->

## 待初始化高风险模块

<!-- 格式：模块名 | 路径1,路径2 | 标签a,标签b -->

## 跨模块触发器

命中以下内容时，即使只改单侧，也要查平行实现：<!-- 按项目填写 -->

## 新模块

满足任一项即可建模块：
- 用户需求形成持久业务行为（跨会话有效的契约 / 边界 / 权责划分）
- 修复了可复用的 bug（根因值得记录）
- 存在平行实现需要联动
