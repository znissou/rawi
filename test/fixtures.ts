// Session-file entries shaped like Claude Code 2.1.x writes them (synthetic text, real structure).

let n = 0;
const now = () => new Date().toISOString();

export function prompt(text: string, cwd = 'C:\\work\\demo', at = now()) {
  return { type: 'user', isSidechain: false, cwd, timestamp: at, uuid: `u${++n}`, message: { role: 'user', content: text } };
}

/** A background task's notification: a prompt Claude Code sends Claude itself. */
export function notification(cwd = 'C:\\work\\demo', at = now()) {
  return {
    type: 'user', isSidechain: false, cwd, timestamp: at, uuid: `u${++n}`, promptSource: 'system',
    origin: { kind: 'task-notification', producer: 'session-task', runId: `r${n}` }, queueSkipAttachments: true,
    message: { role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>' },
  };
}

/** The summary that starts a compacted conversation, also written by Claude Code itself. */
export function compactSummary(cwd = 'C:\\work\\demo', at = now()) {
  return {
    type: 'user', isSidechain: false, cwd, timestamp: at, uuid: `u${++n}`, isCompactSummary: true, isVisibleInTranscriptOnly: true,
    message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' },
  };
}

export function toolResult(cwd = 'C:\\work\\demo', at = now()) {
  return {
    type: 'user', isSidechain: false, cwd, timestamp: at, uuid: `u${++n}`,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: 'ok' }] },
  };
}

type Block = { type: 'thinking'; thinking: string } | { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: object };

export function assistant(id: string, blocks: Block[], stop: 'end_turn' | 'tool_use' | null, opts: { cwd?: string; at?: string; sidechain?: boolean } = {}) {
  return {
    type: 'assistant', isSidechain: opts.sidechain ?? false, cwd: opts.cwd ?? 'C:\\work\\demo', timestamp: opts.at ?? now(), uuid: `a${++n}`,
    message: { id, role: 'assistant', model: 'claude-test', content: blocks, stop_reason: stop },
  };
}

export const think = (t = 'hmm'): Block => ({ type: 'thinking', thinking: t });
export const text = (t: string): Block => ({ type: 'text', text: t });
export const tool = (name = 'Read'): Block => ({ type: 'tool_use', id: `t${++n}`, name, input: {} });

export function title(t: string) {
  return { type: 'ai-title', aiTitle: t };
}

export const jsonl = (entries: object[]) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
