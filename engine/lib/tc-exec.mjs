// TC 验证命令执行器：从 V 字段提取命令 + 危险模式确定性拒绝。
// verify.mjs 与 finalize.mjs（P4 Stop 自动验证）共用——同一套执行语义。

export const extractCommands = (verifyText) => {
  const commands = [];
  for (const match of String(verifyText ?? '').matchAll(/`([^`]+)`/g)) {
    const command = match[1].trim();
    if (command) {
      commands.push(command);
    }
  }
  return commands;
};

// 危险模式清单：目标是拦"误写/误执行"级别的破坏，不是对抗刻意绕过（变量拼接、
// base64 中转等绕过手段必然存在）——真要跑不可信内容请放进容器。模式命中即拒绝执行。
export const UNSAFE_CHECKS = [
  ['rm 递归强删', (cmd) => /\brm\b/.test(cmd) && /(^|\s)-[a-zA-Z]*r/.test(cmd) && /(^|\s)-[a-zA-Z]*f/.test(cmd)],
  ['提权执行', (cmd) => /\b(sudo|doas)\b/.test(cmd)],
  ['格式化文件系统', (cmd) => /\bmkfs(\.\w+)?\b/.test(cmd)],
  ['dd 写裸设备', (cmd) => /\bdd\b[^|]*\bof=\/dev\//.test(cmd)],
  ['重定向写裸设备', (cmd) => />\s*\/dev\/(sd|disk|nvme|mmc)/.test(cmd)],
  ['关机/重启', (cmd) => /\b(shutdown|reboot|halt|poweroff)\b/.test(cmd)],
  ['下载内容直接进 shell', (cmd) => /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(cmd)],
  ['fork 炸弹', (cmd) => /:\s*\(\)\s*\{\s*:\s*\|/.test(cmd)],
  ['递归改权限到系统路径', (cmd) => /\bch(mod|own)\s+-R\b[^|]*\s(~|\/(?!tmp))/.test(cmd)]
];

export const findUnsafe = (command) => UNSAFE_CHECKS.find(([, test]) => test(command))?.[0];
