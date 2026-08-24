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

const normalizeChangedFilePath = (filePath, { cwd } = {}) => {
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
