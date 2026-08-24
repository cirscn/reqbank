#!/usr/bin/env node
// CI 诊断汇总：读取各套件的 /tmp/<suite>.{rc,log}，失败者把关键行打成 GitHub annotation
// （annotations 经公开 API 可读——无日志权限也能定位失败面，尤其 Windows 调试期）。
import { readFileSync } from 'node:fs';

const suites = ['p0', 'p1', 'p2', 'p3p4', 'p5', 'adv', 'smoke'];
let failed = 0;
for (const suite of suites) {
  let rc = '0';
  try {
    rc = readFileSync(`/tmp/${suite}.rc`, 'utf8').trim();
  } catch {
    continue; // 该套件未运行（不应发生——continue-on-error 保证都跑）
  }
  if (rc === '0') continue;
  failed += 1;
  let message = '';
  try {
    const log = readFileSync(`/tmp/${suite}.log`, 'utf8');
    const keyLines = log.split(/\r?\n/).filter((l) => l.includes('✗') || l.includes('失败') || /Error|ENOENT|TypeError/.test(l));
    message = (keyLines.slice(0, 5).join(' ⏎ ') || log.slice(-400)).slice(0, 700);
  } catch {}
  message = message.replace(/[^\x20-\x7e\u4e00-\u9fff]/g, ' ').trim();
  console.log(`::error title=${suite}-fail::${message}`);
}
if (failed > 0) {
  console.error(`[ci-diagnostics] ${failed} 个套件失败（见 annotations）`);
  process.exit(1);
}
console.log('[ci-diagnostics] 全部套件通过');
