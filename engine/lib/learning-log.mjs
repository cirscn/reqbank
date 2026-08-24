// Append-only JSONL learning log shared by all harness hooks.
// Each hook writes one record per invocation; reflect mode reads the full log
// to detect dead rules, recall hit rates, and finalize block patterns.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoPath } from './repo-paths.mjs';

const LOG_PATH = repoPath('.agentdoc', 'harness', 'learning-log.jsonl');
const PAYLOAD_SAMPLE_DIR = repoPath('.agentdoc', 'harness', 'hook-payloads');
const MAX_RAW_CHARS = 200_000;
const KEEP_RAW_PAYLOAD = process.env.HARNESS_KEEP_RAW_PAYLOAD === '1';

const ensureLogDir = () => {
  const dir = dirname(LOG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
};

const ensurePayloadSampleDir = () => {
  if (!existsSync(PAYLOAD_SAMPLE_DIR)) {
    mkdirSync(PAYLOAD_SAMPLE_DIR, { recursive: true });
  }
};

const safeSegment = (value) => String(value ?? 'none')
  .replace(/[^a-zA-Z0-9._-]+/g, '_')
  .slice(0, 80);

const summarizeValueShape = (value, depth = 0) => {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      return { type: 'string', length: value.length, preview: value.slice(0, 120) };
    }
    return { type: typeof value };
  }
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      first: depth < 3 && value.length ? summarizeValueShape(value[0], depth + 1) : undefined
    };
  }
  const keys = Object.keys(value);
  return {
    type: 'object',
    keys,
    fields: depth < 3
      ? Object.fromEntries(keys.map((key) => [key, summarizeValueShape(value[key], depth + 1)]))
      : undefined
  };
};

export const readHookStdin = async () => {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
};

export const parseHookPayload = (raw) => {
  if (!raw.trim()) {
    return { input: {}, parseError: null };
  }
  try {
    return { input: JSON.parse(raw), parseError: null };
  } catch (err) {
    return { input: {}, parseError: err };
  }
};

export const appendPayloadSample = ({ event, raw, input, parseError }) => {
  try {
    ensurePayloadSampleDir();
    const timestamp = new Date().toISOString();
    const rawText = raw ?? '';
    const rawTruncated = rawText.length > MAX_RAW_CHARS;
    const sessionId = input?.session_id ?? null;
    const turnId = input?.turn_id ?? null;
    const fileName = [
      timestamp.replace(/[:.]/g, '-'),
      process.pid,
      safeSegment(event),
      safeSegment(sessionId),
      safeSegment(turnId)
    ].join('__');
    const path = join(PAYLOAD_SAMPLE_DIR, `${fileName}.json`);
    const record = {
      timestamp,
      event,
      session_id: sessionId,
      turn_id: turnId,
      input_keys: Object.keys(input ?? {}),
      tool_input_keys: input?.tool_input && typeof input.tool_input === 'object' ? Object.keys(input.tool_input) : [],
      raw_length: rawText.length,
      raw_sha256: createHash('sha256').update(rawText).digest('hex'),
      raw_truncated: rawTruncated,
      raw_preview: rawText.slice(0, 800),
      raw: KEEP_RAW_PAYLOAD ? (rawTruncated ? rawText.slice(0, MAX_RAW_CHARS) : rawText) : undefined,
      parse_error: parseError?.message ?? null,
      parsed_input_shape: summarizeValueShape(input ?? {}),
      parsed_input: KEEP_RAW_PAYLOAD && !rawTruncated ? input : undefined
    };
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return path;
  } catch (err) {
    process.stderr.write(`[harness-hook] payload sample failed: ${err.message}\n`);
    return null;
  }
};

export const appendLog = (record) => {
  try {
    ensureLogDir();
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...record });
    appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
  } catch (err) {
    // 不阻塞 codex；学习日志失败仅影响后续 reflect 数据完整性。
    process.stderr.write(`[harness-hook] learning-log append failed: ${err.message}\n`);
  }
};

export const readLogLines = () => {
  if (!existsSync(LOG_PATH)) {
    return [];
  }
  return readFileSync(LOG_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

export const findLastEvent = (eventName, predicate = () => true) => {
  const lines = readLogLines();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].event === eventName && predicate(lines[index])) {
      return lines[index];
    }
  }
  return null;
};

export const findEventsByTurn = (turnId) => {
  return readLogLines().filter((record) => record.turn_id === turnId);
};
