#!/usr/bin/env node
// 示例：在真实 Java/Spring 仓库（bpms/backend）上按「考古协议」播种需求银行。
// 来源：2026-08-24 第二仓库验证。核心手法：
//   1. 先探测代码现状基线（grep 计数），文档禁令与存量有出入时用「存量封顶、增量不得新增」句式；
//   2. 考古推断（未逐条人工核实的）标 active:inferred，待 reqbank confirm 人审；
//   3. TC 用真实文件/真实基线计数，不用理想化断言。
// 本脚本仅作参考示例——每个仓库的约定和基线不同，请按 agent-guide.md 的五步协议重新考古。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2] ?? '/Users/aaron/Project/cirscn/bpms/backend';
const HARNESS = join(ROOT, '.agentdoc', 'harness');
const md = (lines) => lines.join('\n') + '\n';

const MODULES = [
  {
    name: 'mapper-sql',
    desc: '复杂 SQL 落 Mapper XML',
    paths: ['- `src/main/java/com/gpm/mapper/` [strong] | mapper-sql,annotation-sql'],
    reqs: [['REQ-001', 'mapper-sql,annotation-sql', 'TC-001', 'active:confirmed', '注解 SQL 存量封顶 23 处不得新增',
      '复杂 SQL 必须写入 Mapper XML；Mapper 接口禁止承载 @Select/@Update 大段 SQL。存量 23 处封顶，增量不得新增。',
      ['REQ-001 | forbid-add | @Select', 'REQ-001 | forbid-add | @Update(']]],
    tcs: [['TC-001', 'mapper-sql', 'REQ-001', '全库扫描注解 SQL', 'grep 计数', '不超基线 23',
      'sh -c \'test $(grep -rn "@Select\\|@Update(" src/main/java --include="*.java" | wc -l) -le 23\'']]
  },
  {
    name: 'fallback-ban',
    desc: '字段兜底禁令',
    paths: [
      '- `src/main/java/com/gpm/converter/` [strong] | fallback-ban,alias-ban',
      '- `src/main/java/com/gpm/service/` [strong] | fallback-ban,alias-ban'
    ],
    reqs: [['REQ-002', 'fallback-ban,alias-ban', 'TC-002', 'active:confirmed', '禁止字段别名映射与多字段择值兜底',
      '字段定义为 A 时只允许接收 A——不得别名映射/多字段择值兜底。旧别名 sectionCode 存量 14 处封顶，增量不得新增。',
      ['REQ-002 | forbid-add | sectionCode']]],
    tcs: [['TC-002', 'fallback-ban', 'REQ-002', '全库扫描旧别名', 'grep 计数', '不超基线 14',
      'sh -c \'test $(grep -rn "sectionCode" src/main/java --include="*.java" | wc -l) -le 14\'']]
  }
];

rmSync(join(HARNESS, 'modules'), { recursive: true, force: true });
for (const mod of MODULES) {
  const dir = join(HARNESS, 'modules', mod.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.md'), md([`# ${mod.name}`, '', '## 命中路径', '', ...mod.paths, '']));
  writeFileSync(join(dir, 'requirements.md'), md([
    `# ${mod.name}`, '', '## 索引', '',
    ...mod.reqs.map(([id, tags, tc, meta, title]) => `${id} | ${tags} | ${tc} | ${meta} | ${title}`),
    '', '## 需求澄清', '',
    ...mod.reqs.flatMap((req) => [`${req[0]}: ${req[5]}`, '']),
    '## 断言', '', ...mod.reqs.flatMap((req) => req[6] ?? [])
  ]));
  writeFileSync(join(dir, 'tests.md'), md([
    `# ${mod.name}`, '', '## 内容索引', '',
    ...mod.tcs.map(([id, tags, ref]) => `${id} | ${tags} | ${ref} | 用例`),
    '', '## 测试用例', '',
    ...mod.tcs.map(([id, , , g, w, e, v]) => `${id}: G=${g} | W=${w} | E=${e} | V=\`${v}\``)
  ]));
}
writeFileSync(join(HARNESS, 'index.md'), md([
  '# 需求银行索引', '', '## 已建模块', '',
  ...MODULES.map((m) => `${m.name} | .agentdoc/harness/modules/${m.name}/ | ${m.desc}`), ''
]));
console.log(`示例银行已写入 ${HARNESS}（${MODULES.length} 模块）`);
