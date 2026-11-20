import { WatchedReply } from './watcher';

export type Reply = WatchedReply;

export interface Session {
  id: string;
  title: string;
  cwd: string;
  /** Oldest first. */
  replies: Reply[];
  updated: number;
}

const MAX_REPLIES = 30;
const MAX_SESSIONS = 30;

/** The replies rawi knows about, by session, for the Replies list and "read last reply". */
export class ReplyStore {
  private readonly sessions = new Map<string, Session>();
  private readonly byId = new Map<string, Reply>();
  private listeners: Array<() => void> = [];

  add(reply: Reply): boolean {
    if (this.byId.has(reply.id)) return false;
    let s = this.sessions.get(reply.sessionId);
    if (!s) {
      s = { id: reply.sessionId, title: reply.title, cwd: reply.cwd, replies: [], updated: 0 };
      this.sessions.set(s.id, s);
    }
    if (reply.title) s.title = reply.title;
    if (reply.cwd) s.cwd = reply.cwd;
    s.replies.push(reply);
    s.replies.sort((a, b) => a.at - b.at);
    while (s.replies.length > MAX_REPLIES) this.byId.delete(s.replies.shift()!.id);
    s.updated = Math.max(s.updated, reply.at);
    this.byId.set(reply.id, reply);
    this.trimSessions();
    this.changed();
    return true;
  }

  setTitle(sessionId: string, title: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.title === title) return;
    s.title = title;
    for (const r of s.replies) r.title = title;
    this.changed();
  }

  get(id: string): Reply | undefined {
    return this.byId.get(id);
  }

  latest(): Reply | undefined {
    let best: Reply | undefined;
    for (const r of this.byId.values()) if (!best || r.at > best.at) best = r;
    return best;
  }

  /** Most recently active first. */
  list(): Session[] {
    return [...this.sessions.values()].filter((s) => s.replies.length).sort((a, b) => b.updated - a.updated);
  }

  clear(): void {
    this.sessions.clear();
    this.byId.clear();
    this.changed();
  }

  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private trimSessions(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const oldest = [...this.sessions.values()].sort((a, b) => a.updated - b.updated);
    for (const s of oldest.slice(0, this.sessions.size - MAX_SESSIONS)) {
      for (const r of s.replies) this.byId.delete(r.id);
      this.sessions.delete(s.id);
    }
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }
}
