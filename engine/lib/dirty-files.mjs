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
  && !file.startsWith('.codex/')
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
