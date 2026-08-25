import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { repoPath } from './repo-paths.mjs';

const git = (args) => execFileSync('git', args, { cwd: repoPath(), encoding: 'utf8' });

const hashText = (value) => createHash('sha256').update(value).digest('hex');
const hashBuffer = (value) => createHash('sha256').update(value).digest('hex');

const splitNullOutput = (output) => output.split('\0').map((file) => file.trim()).filter(Boolean);

const getChangedFiles = () => {
  const commands = [
    ['diff', '--relative', '--name-only', '-z'],
    ['diff', '--relative', '--name-only', '--cached', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z']
  ];
  const files = new Set();
  for (const args of commands) {
    const output = git(args);
    for (const file of splitNullOutput(output)) {
      files.add(file);
    }
  }
  return [...files].sort();
};

export const isBusinessFile = (file) => (
  !file.startsWith('.agentdoc/')
  && !file.startsWith('.harness/')
  && !file.startsWith('.codex/')
  && !file.startsWith('.claude/')
  && file !== 'AGENTS.md'
  && file !== '.gitignore'
  && file !== 'package.json'
  && file !== 'scripts/check-harness-doctor.mjs'
  && file !== 'scripts/harness-smoke.mjs'
  && file !== 'scripts/harness-learning-report.mjs'
);

const getFileContentSignature = (file) => {
  const absolutePath = repoPath(file);
  if (!existsSync(absolutePath)) {
    return 'missing';
  }
  const stat = statSync(absolutePath);
  if (!stat.isFile()) {
    return `non-file:${stat.size}:${stat.mtimeMs}`;
  }
  return hashBuffer(readFileSync(absolutePath));
};

const getGitDiffSignature = (file, cached = false) => {
  try {
    const args = cached ? ['diff', '--cached', '--', file] : ['diff', '--', file];
    return hashText(git(args));
  } catch {
    return 'diff-error';
  }
};

const getFileDirtyRecord = (file) => {
  const signature = hashText([
    getFileContentSignature(file),
    getGitDiffSignature(file, false),
    getGitDiffSignature(file, true)
  ].join('\0'));
  return { file, signature };
};

export const getDirtyFileRecords = () => {
  try {
    return getChangedFiles().map(getFileDirtyRecord);
  } catch {
    return [];
  }
};

export const getDirtyBusinessFileRecords = () => (
  getDirtyFileRecords().filter((record) => isBusinessFile(record.file))
);

const isTrackedFile = (file) => {
  try {
    return git(['ls-files', '--error-unmatch', '--', file]).trim().length > 0;
  } catch {
    return false;
  }
};

const UNTRACKED_DIFF_BYTES = 1_000_000;

// 未跟踪新文件 `git diff` 为空：合成「全是新增行」的 unified diff，让 forbid-add / forbid-call
// 能看见内容；超大或二进制只留路径头，forbid-path 仍靠 filePaths 命中。
const synthesizeUntrackedDiff = (file) => {
  const absolutePath = repoPath(file);
  if (!existsSync(absolutePath)) {
    return '';
  }
  let stat;
  try {
    stat = statSync(absolutePath);
  } catch {
    return '';
  }
  if (!stat.isFile()) {
    return '';
  }
  const header = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n`;
  if (stat.size === 0 || stat.size > UNTRACKED_DIFF_BYTES) {
    return header;
  }
  let content;
  try {
    content = readFileSync(absolutePath);
  } catch {
    return header;
  }
  if (content.includes(0)) {
    return header;
  }
  const lines = content.toString('utf8').split('\n');
  return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
};

// 盘上终态 diff（unstaged + staged + 未跟踪合成）：Stop / gate dirty 用。
export const getBusinessFileUnifiedDiff = (file) => {
  try {
    const unstaged = git(['diff', '--', file]);
    const staged = git(['diff', '--cached', '--', file]);
    const combined = `${unstaged}${unstaged && staged ? '\n' : ''}${staged}`;
    if (combined.trim()) {
      return combined;
    }
    if (!isTrackedFile(file)) {
      return synthesizeUntrackedDiff(file);
    }
    return '';
  } catch {
    return '';
  }
};

export const getDirtyBusinessFileChangesSinceBaseline = (baselineRecords) => {
  const currentRecords = getDirtyBusinessFileRecords();
  if (!Array.isArray(baselineRecords)) {
    return {
      newFiles: currentRecords.map((record) => record.file),
      changedExistingFiles: []
    };
  }

  const baselineSignatures = new Map(
    baselineRecords.map((record) => [record.file, record.signature])
  );
  const newFiles = [];
  const changedExistingFiles = [];
  for (const record of currentRecords) {
    if (!baselineSignatures.has(record.file)) {
      newFiles.push(record.file);
      continue;
    }
    if (baselineSignatures.get(record.file) !== record.signature) {
      changedExistingFiles.push(record.file);
    }
  }

  return { newFiles, changedExistingFiles };
};
