/**
 * Reads one Claude Code session file, entry by entry, and finds its replies.
 *
 * A reply is the text of a finished turn. By default that's only the final answer: the text after
 * the turn's last tool call. With `all`, it's every text block of the turn. Subagent, meta,
 * synthetic and API-error entries are skipped.
 *
 * A turn counts as finished when an assistant message ends with `end_turn` (or `stop_sequence`).
 * The parser only marks it as waiting; the caller decides when to `flush()` it (rawi waits 0.15 s,
 * in case another line of the same message is still being written).
 *
 * A new turn starts with a prompt: one the user sent, or one Claude Code sent itself, when a background
 * task finished or the conversation was compacted. Only the user's prompts stop the reading.
 */

export type ReadWhich = 'final' | 'all';

export interface FinishedReply {
  messageId: string;
  text: string;
  /** ISO timestamp of the message, as Claude Code wrote it. */
  at?: string;
}

export type ParseEvent =
  /** `byUser`: false when Claude Code sent the prompt itself (a background task finished, or compaction). */
  | { kind: 'prompt'; at?: string; byUser: boolean }
  | { kind: 'title'; title: string }
  /** A finished reply handed over early by the next prompt; `interrupted` when the user sent it. */
  | { kind: 'reply'; reply: FinishedReply; interrupted: boolean };

// The parts of a session-file entry rawi reads. Everything else is ignored.
interface Block { type?: string; text?: unknown }
interface Entry {
  type?: string;
  aiTitle?: unknown;
  isSidechain?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  isCompactSummary?: unknown;
  origin?: { kind?: unknown } | null;
  cwd?: unknown;
  timestamp?: unknown;
  message?: { id?: unknown; model?: unknown; content?: unknown; stop_reason?: unknown };
}

const KEEP_FLUSHED = 64;

export class SessionParser {
  cwd = '';
  title = '';
  private finalTexts: string[] = [];
  private allTexts: string[] = [];
  private messageId: string | undefined;
  private finishedId: string | undefined;
  private finishedAt: string | undefined;
  private flushed: string[] = [];

  constructor(private readonly which: () => ReadWhich = () => 'final') {}

  /** True when a finished turn is waiting to be flushed. */
  get waiting(): boolean {
    return this.finishedId !== undefined;
  }

  feed(raw: unknown): ParseEvent[] {
    if (!raw || typeof raw !== 'object') return [];
    const e = raw as Entry;

    if (e.type === 'ai-title') {
      if (typeof e.aiTitle !== 'string' || !e.aiTitle || e.aiTitle === this.title) return [];
      this.title = e.aiTitle;
      return [{ kind: 'title', title: this.title }];
    }
    if (e.isSidechain || e.isMeta) return [];
    if (typeof e.cwd === 'string' && e.cwd) this.cwd = e.cwd;

    const message = e.message ?? {};
    const content = message.content;
    const at = typeof e.timestamp === 'string' ? e.timestamp : undefined;

    if (e.type === 'user') {
      const isPrompt = typeof content === 'string'
        || (Array.isArray(content) && !content.some((b: Block) => b?.type === 'tool_result'));
      if (!isPrompt) return [];
      const byUser = !sentByClaudeCode(e, content);
      const events: ParseEvent[] = [];
      // A reply not flushed yet was cut short only by the user's own prompt: after Claude Code's, it's read.
      const pending = this.flush();
      if (pending) events.push({ kind: 'reply', reply: pending, interrupted: byUser });
      this.resetTurn();
      events.push({ kind: 'prompt', at, byUser });
      return events;
    }

    if (e.type !== 'assistant' || !Array.isArray(content)) return [];
    if (e.isApiErrorMessage || message.model === '<synthetic>') return [];
    const id = typeof message.id === 'string' ? message.id : undefined;
    if (id && this.flushed.includes(id)) return []; // a late line of a reply already returned

    if (id !== this.messageId) {
      this.messageId = id;
      this.finishedId = undefined; // the turn went on after an end_turn (a Stop hook can do that)
    }
    for (const b of content as Block[]) {
      if (b?.type === 'tool_use') {
        this.finalTexts = [];
      } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        this.finalTexts.push(b.text);
        this.allTexts.push(b.text);
      }
    }
    const stop = message.stop_reason;
    if (id && (stop === 'end_turn' || stop === 'stop_sequence')) {
      this.finishedId = id;
      this.finishedAt = at;
    }
    return [];
  }

  /** Returns the finished turn's reply, if it has any text, and starts a new turn. */
  flush(): FinishedReply | undefined {
    if (!this.finishedId) return undefined;
    const texts = this.which() === 'all' ? this.allTexts : this.finalTexts;
    const text = texts.join('\n\n').trim();
    if (!text) return undefined; // its text line hasn't arrived yet
    const reply: FinishedReply = { messageId: this.finishedId, text, at: this.finishedAt };
    this.flushed.push(this.finishedId);
    if (this.flushed.length > KEEP_FLUSHED) this.flushed.shift();
    this.resetTurn();
    return reply;
  }

  private resetTurn(): void {
    this.finalTexts = [];
    this.allTexts = [];
    this.finishedId = undefined;
    this.finishedAt = undefined;
  }
}

/**
 * Prompts Claude Code writes itself, as seen in Claude Code 2.1.281 to 2.1.325: a background task's
 * notification (`origin.kind` "task-notification", its text in <task-notification> tags; its
 * `promptSource` can be "sdk", like a typed prompt's) and the summary that starts a compacted conversation.
 */
function sentByClaudeCode(e: Entry, content: unknown): boolean {
  if (e.isCompactSummary === true || e.origin?.kind === 'task-notification') return true;
  const first = typeof content === 'string' ? content : (content as Block[]).find((b) => b?.type === 'text')?.text;
  return typeof first === 'string' && first.trimStart().startsWith('<task-notification>');
}
