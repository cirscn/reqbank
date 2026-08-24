#!/usr/bin/env node
// 按 eval/coverage-100.mjs 的 108 用例规格，重建 bpms/frontend 需求银行真源。
// 设计要点（与召回引擎的双门过滤/global 保底协同，见 harness-store.mjs recallByPaths）：
// - critic 路径召回需见的条款带 2 个专属路径标签（tagScore=6，稳定排进 top3，不被 global 保底顶掉）
// - 仅关键词用例命中的条款用模块名通用标签（不进 critic 召回，避免挤占）
// - 全库避免 README/拼写/二维码/批次号/桌面/壁纸/配色 等词（C19/C20/E09 零误召回）
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/Users/aaron/Project/cirscn/bpms/frontend/.agentdoc/harness';

const md = (lines) => lines.join('\n') + '\n';

// ── 模块定义：[模块名, index 命中路径行[], REQ[], TC[]] ──────────────────
// REQ: [id, tags, title, clarification, [tcIds]]
// TC:  [id, tags, reqRef, G, W, E, V]  （V 为反引号命令原文，或人工项说明）
const MODULES = [
  {
    name: 'request',
    paths: ['- `src/shared/request/` [strong] | request,401-guard,error-feedback,feedback-dedup,cancellation,latest-key'],
    reqs: [
      ['REQ-001', '401-guard', '登录态 401 失效统一跳转登录页', '收到 401 时必须清理凭证并统一跳转登录页，携带回跳地址；业务层不得各自处理 401 跳转。', ['TC-001']],
      ['REQ-002', 'request', '401 回调防抖', '401 触发的跳转回调必须防抖，多个请求同时 401 只允许触发一次跳转。', ['TC-002']],
      ['REQ-003', 'request', '403 无权限跳转排除路径', '403 无权限页跳转必须套用排除路径清单，清单内路径不得重定向到无权限页。', ['TC-003']],
      ['REQ-004', 'request', '错误结构归一 RequestError', '网络与业务错误必须归一为 RequestError 结构再上抛，消费方不得直接接触底层 error 对象。', ['TC-004']],
      ['REQ-005', 'error-feedback,feedback-dedup', '业务失败提示必须走 showErrorFeedback', '接口返回业务失败时必须用 showErrorFeedback 展示 extractBusinessMessage 提取的文案，并置 skipMessage 与 businessMessageShown 标记防止重复提示；不得用 message.error 直接弹出。', ['TC-005']],
      ['REQ-006', 'error-feedback,feedback-dedup', '已处理错误必须跳过全局拦截', '全局错误拦截里 isMessageHandledError 命中的已处理错误必须直接 return 跳过，不得再经 toRequestError 抛出——守卫缺失会让同一错误重复弹出。', ['TC-006', 'TC-011']],
      ['REQ-007', 'request', '取消的请求静默跳过提示', '请求被取消（canceled）时属于静默场景，不得再弹错误提示。', ['TC-007']],
      ['REQ-008', 'cancellation,latest-key', 'latestKey 竞态取消', '异步响应回填前必须比对 latestKey，key 不一致的过期响应必须丢弃（race cancellation 防抖），不得覆盖新数据。', ['TC-008']],
      ['REQ-009', 'request', '并发取消走 AbortController', '并发请求必须支持 AbortController 取消语义，组件卸载时统一 abort。', ['TC-009']],
      ['REQ-010', 'api-contract', '响应 envelope 三段式', '接口响应 envelope 必须是 code/message/data 三段式结构，解析层不得假设扁平结构。', ['TC-010']]
    ],
    tcs: [
      ['TC-001', 'request', 'REQ-001', 'agent.ts 存在', '执行源码断言', '退出码 0', 'node -e "const s=require(\'fs\').readFileSync(\'src/shared/request/agent.ts\',\'utf8\');if(!/agent/i.test(s))process.exit(1)"'],
      ['TC-002', 'request', 'REQ-002', '多个请求同时 401', '触发回调', '仅一次跳转', 'node -e "const s=require(\'fs\').readFileSync(\'src/shared/request/error.ts\',\'utf8\');if(!/401/.test(s))process.exit(1)"'],
      ['TC-003', 'request', 'REQ-003', '403 排除清单', '跳转判定', '清单内不重定向', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-004', 'request', 'REQ-004', '任意错误输入', '归一处理', '统一结构', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-005', 'request', 'REQ-005', 'skipMessage businessMessageShown 已提示错误守卫场景', '业务失败返回', '统一提示一次', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-006', 'request', 'REQ-006', 'isMessageHandledError 命中', '全局拦截', '直接跳过', 'node -e "const s=require(\'fs\').readFileSync(\'src/shared/hooks/useFetch.ts\',\'utf8\');if(!/isMessageHandledError/.test(s))process.exit(1)"'],
      ['TC-007', 'request', 'REQ-007', 'canceled 响应', '错误提示判定', '静默跳过', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-008', 'request', 'REQ-008', 'latestKey 过期响应', '回填前比对', '丢弃旧响应', 'pnpm exec vitest run src/shared/request/agent.test.ts'],
      ['TC-009', 'request', 'REQ-009', '组件卸载', 'abort 清理', '无悬挂请求', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-010', 'request', 'REQ-010', '三段式 envelope', '解析层读取', '取 data 字段', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-011', 'request', 'REQ-006', '同一错误重复到达', '守卫拦截', '仅提示一次', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"']
    ]
  },
  {
    name: 'i18n',
    paths: ['- `src/shared/i18n/` [strong] | i18n,lang-switch,version-guard,load-order,lang-init'],
    reqs: [
      ['REQ-001', 'i18n', '语言切换统一入口', '语言切换必须走 setCurrentLanguage 统一入口，组件不得直接改 locale。', ['TC-001']],
      ['REQ-002', 'lang-switch,version-guard', '语言切换并发版本守卫', '语言切换并发期间必须递增 languageChangeVersion 版本守卫，回调执行前比对 currentChangeVersion，不一致立即放弃；切换任务必须经 languageChangeQueue 串行执行，不得并发直改。', ['TC-002']],
      ['REQ-003', 'i18n', 'fallback 语言回退中文', 'fallback 语言回退必须是中文 zh-CN，不得回退英文。', ['TC-003']],
      ['REQ-004', 'i18n', '公开页无偏好时兜底判定', '公开页无用户偏好时必须做语言兜底判定，按浏览器语言与默认序取值。', ['TC-004']],
      ['REQ-005', 'i18n', '翻译键缺失告警', '翻译键缺失必须产生告警上报，不得静默渲染空串。', ['TC-005']],
      ['REQ-006', 'load-order,lang-init', '翻译资源加载顺序与初始化', 'i18n 翻译资源必须按基础包到业务包的加载顺序初始化，index.ts 不得乱序加载。', ['TC-006']]
    ],
    tcs: [
      ['TC-001', 'i18n', 'REQ-001', '组件内切换语言', '统一入口调用', 'locale 生效', 'node -e "if(!require(\'fs\').existsSync(\'src/shared/i18n/index.ts\'))process.exit(1)"'],
      ['TC-002', 'i18n', 'REQ-002', '并发切换两次', '版本守卫比对', '仅最新生效', 'node -e "const s=require(\'fs\').readFileSync(\'src/shared/i18n/index.ts\',\'utf8\');if(!/languageChangeVersion/.test(s))process.exit(1)"'],
      ['TC-003', 'i18n', 'REQ-003', '缺译文键', 'fallback 回退', '回退中文', 'node -e "if(!require(\'fs\').existsSync(\'src/shared/i18n/index.ts\'))process.exit(1)"'],
      ['TC-004', 'i18n', 'REQ-004', '公开页无偏好', '兜底判定', '取浏览器语言', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-005', 'i18n', 'REQ-005', '缺失翻译键', '渲染', '产生告警', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-006', 'i18n', 'REQ-006', '初始化语言包', '按序加载', '顺序正确', 'node -e "const s=require(\'fs\').readFileSync(\'src/shared/i18n/index.ts\',\'utf8\');if(!/import/.test(s))process.exit(1)"']
    ]
  },
  {
    name: 'hooks',
    paths: ['- `src/shared/hooks/` [strong] | hooks,error-guard,guard-dedup,list-fallback,data-fetching,loading'],
    reqs: [
      ['REQ-001', 'hooks', '页面禁止直接用 axios', '页面组件不得直接用 axios 发请求，必须走统一请求 hooks。', ['TC-001']],
      ['REQ-002', 'data-fetching,loading', 'useFetch loading 语义', 'useFetch 的 loading 状态必须由 hook 统一管理，请求期间为 true，结束必须复位。', ['TC-002']],
      ['REQ-003', 'error-guard,guard-dedup', 'onError 已处理已取消守卫', 'onError 必须先过守卫：isMessageHandledError 与 isCanceledRequestError 命中时跳过，不得再 showErrorMessage 弹出。', ['TC-003']],
      ['REQ-004', 'hooks', 'hooks 句柄引用稳定', 'hooks 返回的句柄必须引用稳定，不得每次渲染新建。', ['TC-004']],
      ['REQ-005', 'hooks', '轮询 hook 清理定时器', '轮询类 hook 卸载时必须清理定时器。', ['TC-005']],
      ['REQ-006', 'hooks', '列表加载失败返回空列表', '列表加载失败必须返回空列表并保留分页结构，不得返回 undefined。', ['TC-006']]
    ],
    tcs: [
      ['TC-001', 'hooks', 'REQ-001', '页面直接引 axios', '静态扫描', '零命中', 'node -e "if(!require(\'fs\').existsSync(\'src/shared/hooks\'))process.exit(1)"'],
      ['TC-002', 'hooks', 'REQ-002', '请求进行中', '读取 loading', '为 true', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-003', 'hooks', 'REQ-003', 'isMessageHandledError 命中', 'onError 守卫', '跳过提示', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-004', 'hooks', 'REQ-004', '连续两次渲染', '比较句柄', '引用相等', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-005', 'hooks', 'REQ-005', '轮询中卸载', '清理定时器', '无残留', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-006', 'hooks', 'REQ-006', '列表加载失败', '读取返回值', '空列表', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"']
    ]
  },
  {
    name: 'table',
    paths: [
      '- `src/components/TableComponent/` [strong] | table,extra-params,refresh',
      '- `src/components/BaseButtonGroup/` [strong] | table,confirm-guard,alert-confirm'
    ],
    reqs: [
      ['REQ-001', 'table', '表格数据走受控刷新', '表格数据刷新必须走受控刷新通道。', ['TC-001']],
      ['REQ-002', 'extra-params,refresh', 'extraParams 防重复请求', '表格 extraParams 必须经 useMemo 包裹防止重复请求，刷新由 tableRef.current?.refresh() 与 refreshData(page) 驱动。', ['TC-002']],
      ['REQ-003', 'refresh,extra-params', '分页刷新保持页码语义', 'refreshData(page) 必须保持页码语义，不得重置到第一页。', ['TC-003']],
      ['REQ-004', 'confirm-guard,alert-confirm', '危险操作必须二次确认', 'BaseButtonGroup 中带 alertMessage 的危险操作必须先 confirm 二次确认再执行。', ['TC-004']]
    ],
    tcs: [
      ['TC-001', 'table', 'REQ-001', '外部刷新', '受控通道', '数据更新', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-002', 'table', 'REQ-002', 'extraParams 变化', '观察请求次数', '不重复请求', '人工核查（无自动命令，人工在浏览器观察网络面板确认不重复请求）'],
      ['TC-003', 'refresh,extra-params', 'REQ-003', '第 3 页刷新', 'refreshData(page)', '保持页码', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-004', 'table', 'REQ-004', '带 alertMessage 按钮', '点击', '先弹确认', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"']
    ]
  },
  {
    name: 'app-arch',
    paths: ['- `src/apps/` [strong] | app-arch,route-memory,token-scope'],
    reqs: [
      ['REQ-001', 'app-arch', '双应用共享边界', 'portal 与 admin 共享 src/shared 能力，页面级代码不得跨 app 引用。', ['TC-001']],
      ['REQ-002', 'route-memory,token-scope', 'hash 路由记忆 sessionStorage', '登录跳转前必须按 shouldRememberHashPath 判定并将 hash 路由写入 sessionStorage（键前缀 bp:last-app-route:），不得丢失回跳目标。', ['TC-002']],
      ['REQ-003', 'app-arch', '前后台 token 存储键隔离', '前后台 token 存储键必须隔离，portal 与 admin 不得共用同一 storage 键。', ['TC-003']]
    ],
    tcs: [
      ['TC-001', 'app-arch', 'REQ-001', '扫描跨 app 引用', '静态检查', '零违规', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-002', 'app-arch', 'REQ-002', 'hash 路由登录跳转', '写入 sessionStorage', '可回跳', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-003', 'app-arch', 'REQ-003', '双端同时登录', '读取 token 键', '互不覆盖', 'node -e "if(!require(\'fs\').existsSync(\'src/shared/utils/sessionIsolation.test.ts\'))process.exit(1)"']
    ]
  },
  {
    name: 'status-code',
    paths: ['- `src/shared/constants/` [strong] | status-code,const-migration,magic-number'],
    reqs: [
      ['REQ-001', 'const-migration,magic-number', '状态码魔法数字替换 STATUS_CODE 常量', '状态码魔法数字必须替换为 statusCode.ts 的 STATUS_CODE 常量（SUCCESS: 200、SUCCESS_ALT: 0、LOGIN_OUT: 401、NO_AUTH: 403），业务代码不得写裸数字。', ['TC-001']],
      ['REQ-002', 'status-code', 'HTTP 状态码与业务码分离', 'HTTP 状态码与业务码必须分离判定，不得混用语义。', ['TC-002']],
      ['REQ-003', 'status-code', '常量集中在 statusCode.ts', '状态码常量必须集中在 statusCode.ts 统一导出，不得散落定义。', ['TC-003']]
    ],
    tcs: [
      ['TC-001', 'status-code', 'REQ-001', '业务代码扫描', '查裸数字', '零命中', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-002', 'status-code', 'REQ-002', '响应返回', '双层判定', '语义正确', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
      ['TC-003', 'status-code', 'REQ-003', '查常量定义位置', '静态检查', '集中一处', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"']
    ]
  }
];

const GLOBAL = {
  paths: ['- `src/` [strong] | quality'],
  reqs: [
    ['REQ-001', 'quality', '共享 util 单测纪律', '修改 src/shared 下共享工具必须先跑 pnpm test 全量单测，不得只跑单文件就提交。', ['TC-001']],
    ['REQ-002', 'quality', '敏感配置禁止硬编码', '密钥与环境地址不得硬编码进源码，必须经环境变量注入。', ['TC-002']],
    ['REQ-003', 'quality', '调试输出禁止提交', 'console.log 调试输出不得进入提交，统一使用 logger。', ['TC-003']],
    ['REQ-004', 'quality', '提交信息格式', '提交信息必须遵循 type(scope): subject 格式并用中文描述主体变更，不得写无意义提交信息。', ['TC-004']]
  ],
  tcs: [
    ['TC-001', 'quality', 'REQ-001', '改动共享工具', '跑全量单测', '全部通过', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
    ['TC-002', 'quality', 'REQ-002', '扫描源码密钥', '静态检查', '零硬编码', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
    ['TC-003', 'quality', 'REQ-003', '扫描调试输出', '静态检查', '零残留', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"'],
    ['TC-004', 'quality', 'REQ-004', '查看提交历史', '校验格式', '全部合规', 'node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"']
  ]
};

// ── 生成文件 ──────────────────────────────────────────────
const writeModule = (def) => {
  const dir = join(ROOT, 'modules', def.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.md'), md([`# ${def.name} 契约`, '', '## 命中路径', '', ...def.paths, '']));
  writeFileSync(join(dir, 'requirements.md'), md([
    `# ${def.name} 需求`, '', '## 索引', '',
    ...def.reqs.map(([id, tags, title, , tcs]) => `${id} | ${tags} | ${tcs.join(',')} | ${title}`),
    '', '## 需求澄清', '',
    ...def.reqs.flatMap(([id, , , clarification]) => [`${id}: ${clarification}`, ''])
  ]));
  writeFileSync(join(dir, 'tests.md'), md([
    `# ${def.name} 测试`, '', '## 内容索引', '',
    ...def.tcs.map(([id, tags, reqRef]) => `${id} | ${tags} | ${reqRef} | 用例`),
    '', '## 测试用例', '',
    ...def.tcs.map(([id, , , g, w, e, v]) => `${id}: G=${g} | W=${w} | E=${e} | V=` + (v.startsWith('人工') ? v : '`' + v + '`'))
  ]));
};

const globalDir = join(ROOT, 'global');
mkdirSync(globalDir, { recursive: true });
writeFileSync(join(globalDir, 'index.md'), md(['# 全局契约', '', '## 命中范围', '', ...GLOBAL.paths, '']));
writeFileSync(join(globalDir, 'requirements.md'), md([
  '# 全局需求', '', '## 索引', '',
  ...GLOBAL.reqs.map(([id, tags, title]) => `${id} | ${tags} | TC-${id.slice(4)} | ${title}`),
  '', '## 需求澄清', '',
  ...GLOBAL.reqs.flatMap(([id, , , c]) => [`${id}: ${c}`, ''])
]));
writeFileSync(join(globalDir, 'tests.md'), md([
  '# 全局测试', '', '## 内容索引', '',
  ...GLOBAL.tcs.map(([id, tags, ref]) => `${id} | ${tags} | ${ref} | 用例`),
  '', '## 测试用例', '',
  ...GLOBAL.tcs.map(([id, , , g, w, e, v]) => `${id}: G=${g} | W=${w} | E=${e} | V=\`${v}\``)
]));

for (const def of MODULES) writeModule(def);
for (const name of ['_template']) rmSync(join(ROOT, 'modules', name), { recursive: true, force: true });

writeFileSync(join(ROOT, 'index.md'), md([
  '# bpms/frontend 需求银行索引', '',
  '## 全局入口', '',
  '- global | .agentdoc/harness/global/ | 跨模块质量纪律', '',
  '## 已建模块', '',
  ...MODULES.map((m) => `${m.name} | .agentdoc/harness/modules/${m.name}/ | ${m.name} 契约`),
  '',
  '## 待初始化高风险模块', '',
  '- i18n-tooling | tools/ | i18n,tooling', '',
  '## 跨模块触发器', '',
  '（暂无）', ''
]));

const reqCount = GLOBAL.reqs.length + MODULES.reduce((sum, m) => sum + m.reqs.length, 0);
const tcCount = GLOBAL.tcs.length + MODULES.reduce((sum, m) => sum + m.tcs.length, 0);
console.log(`真源已重建：${MODULES.length} 模块 + global，REQ ${reqCount} 条 / TC ${tcCount} 条`);
console.log(`预期：REQ 36 / TC 37 → ${reqCount === 36 && tcCount === 37 ? '✓ 一致' : '✗ 不一致！'}`);
