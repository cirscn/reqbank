import { existsSync, readFileSync } from 'node:fs';

const CALL_TYPES = new Set(['function_call', 'custom_tool_call']);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);

const parseCallArguments = (payload) => {
  const raw = payload.arguments ?? payload.input ?? {};
  if (typeof raw !== 'string') {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const shouldReadRecord = (record, { sinceTimestamp } = {}) => {
  if (!sinceTimestamp) {
    return true;
  }
  if (!record.timestamp) {
    return false;
  }
  return record.timestamp >= sinceTimestamp;
};

export const readTranscriptToolCalls = (transcriptPath, options = {}) => {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return {
      checked: false,
      calls: [],
      error: transcriptPath ? 'missing transcript_path' : 'empty transcript_path',
      records_seen_count: 0
    };
  }

  try {
    const calls = [];
    const callsById = new Map();
    let recordsSeenCount = 0;
    const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter((line) => line.trim());
    for (const line of lines) {
      const record = JSON.parse(line);
      if (!shouldReadRecord(record, options)) {
        continue;
      }
      recordsSeenCount += 1;
      const payload = record.payload ?? {};
      if (OUTPUT_TYPES.has(payload.type)) {
        const call = callsById.get(payload.call_id);
        if (call) {
          call.output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
          call.outputTimestamp = record.timestamp ?? null;
          call.outputType = payload.type;
        }
        continue;
      }
      if (!CALL_TYPES.has(payload.type)) {
        continue;
      }
      if (payload.name) {
        const call = {
          type: payload.type,
          name: payload.name,
          namespace: payload.namespace ?? '',
          callId: payload.call_id ?? null,
          timestamp: record.timestamp ?? null,
          output: null,
          outputTimestamp: null,
          outputType: null,
          arguments: parseCallArguments(payload)
        };
        calls.push(call);
        if (call.callId) {
          callsById.set(call.callId, call);
        }
      }
    }
    return { checked: true, calls, error: null, records_seen_count: recordsSeenCount };
  } catch (err) {
    return { checked: false, calls: [], error: err.message, records_seen_count: 0 };
  }
};

export const hasTranscriptToolCall = (transcriptPath, predicate, options = {}) => {
  const result = readTranscriptToolCalls(transcriptPath, options);
  const matchedCalls = result.calls.filter(predicate);
  return {
    ...result,
    matched: matchedCalls.length > 0,
    matchedCalls
  };
};
