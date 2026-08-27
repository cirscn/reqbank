import { isAbsolute, relative, resolve } from 'node:path';
import { getProjectRoot } from './repo-paths.mjs';

export const normalizeCommandText = (command) => {
  if (!command) {
    return '';
  }
  if (typeof command === 'string') {
    return command;
  }
  if (Array.isArray(command)) {
    return command.join('\n');
  }
  return JSON.stringify(command);
};

export const extractChangedLinesFromApplyPatch = (command) => {
  const text = normalizeCommandText(command);
  if (!text.includes('*** Begin Patch')) {
    return text;
  }

  const changedLines = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^[+-]/.test(line) && !/^(?:\+\+\+|---)/.test(line)) {
      changedLines.push(line);
    }
  }

  return changedLines.length ? changedLines.join('\n') : text;
};

export const normalizeChangedFilePath = (filePath, { cwd } = {}) => {
  let normalized = String(filePath ?? '')
    .trim()
    .replace(/^["'`(（\[]+/, '')
    .replace(/["'`),，。；;:：\]]+$/, '')
    .replace(/^\.\/+/, '');

  const absolutePath = isAbsolute(normalized)
    ? normalized
    : resolve(cwd || getProjectRoot(), normalized);
  const projectRelativePath = relative(getProjectRoot(), absolutePath).replaceAll('\\', '/');
  if (projectRelativePath && !projectRelativePath.startsWith('../')) {
    return projectRelativePath;
  }

  return normalized;
};

export const extractChangedFilePaths = (command, options = {}) => {
  const text = normalizeCommandText(command);
  if (!text) {
    return [];
  }
  const paths = new Set();
  const filePattern = /^\*\*\* (?:(?:Add|Update|Delete) File:|Move to:)\s+(\S.*?)\s*$/gm;
  let match = filePattern.exec(text);
  while (match) {
    const filePath = normalizeChangedFilePath(match[1], options);
    if (filePath) {
      paths.add(filePath);
    }
    match = filePattern.exec(text);
  }
  return [...paths];
};

// Claude Code 的 Edit/Write/MultiEdit 不携带 command 补丁：tool_input 是
// file_path + old_string/new_string（Write 为 content，MultiEdit 为 edits 数组），
// tool_response.structuredPatch 是 unified hunk（{oldStart,oldLines,newStart,newLines,lines}）。
// 统一归一为 { text: '+新增/-删除 行文本', filePaths: [...] }；Codex 的 command
// 形状返回 null，仍走既有 apply_patch 解析通道。实证样本见 2026-08-24 claude 2.1.220 探针。
export const normalizeClaudeCodeEdit = (input) => {
  const toolInput = input?.tool_input;
  const toolResponse = input?.tool_response;
  if (!toolInput || typeof toolInput !== 'object') {
    return null;
  }
  if (typeof toolInput.command === 'string' && toolInput.command) {
    return null;
  }
  // Kimi Code 的 Edit/Write 参数叫 path（语义同 Claude 的 file_path）——
  // 不认它的话文件路径提取为空，critic 召回与沉淀提醒双双静默失效。
  const filePath = toolInput.file_path ?? toolInput.path ?? toolResponse?.filePath;
  if (typeof filePath !== 'string' || !filePath) {
    return null;
  }

  const lines = [];
  const hunks = toolResponse?.structuredPatch;
  if (Array.isArray(hunks)) {
    for (const hunk of hunks) {
      for (const line of hunk?.lines ?? []) {
        if (typeof line === 'string' && line !== '') {
          lines.push(line);
        }
      }
    }
  }
  if (!lines.length) {
    const pushPrefixed = (text, prefix) => {
      for (const line of String(text ?? '').split(/\r?\n/)) {
        if (line !== '') {
          lines.push(prefix + line);
        }
      }
    };
    if (Array.isArray(toolInput.edits)) {
      for (const edit of toolInput.edits) {
        pushPrefixed(edit?.old_string, '-');
        pushPrefixed(edit?.new_string, '+');
      }
    } else if (typeof toolInput.old_string === 'string' || typeof toolInput.new_string === 'string') {
      pushPrefixed(toolInput.old_string, '-');
      pushPrefixed(toolInput.new_string, '+');
    } else if (typeof toolInput.content === 'string') {
      pushPrefixed(toolInput.content, '+');
    }
  }
  if (!lines.length) {
    return null;
  }
  return { text: lines.join('\n'), filePaths: [filePath] };
};
