import * as vscode from 'vscode';
import { Reply, ReplyStore, Session } from '../claude/store';
import { speakableBlocks } from '../text/speakable';

type Node = { kind: 'session'; session: Session } | { kind: 'reply'; reply: Reply };

/** The Replies list: sessions, newest first, each with its replies and a ▶ to hear any of them. */
export class RepliesView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly previews = new Map<string, string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly store: ReplyStore, private readonly playingId: () => string | undefined) {
    this.unsubscribe = store.onChange(() => this.refresh());
  }

  refresh(): void {
    this.changed.fire();
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.store.list().map((session) => ({ kind: 'session', session }));
    if (node.kind === 'session') return [...node.session.replies].reverse().map((reply) => ({ kind: 'reply', reply }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'session') {
      const s = node.session;
      const first = this.store.list()[0]?.id === s.id;
      const item = new vscode.TreeItem(s.title || 'Untitled session',
        first ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `session:${s.id}`;
      item.description = ago(s.updated);
      item.tooltip = s.cwd;
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      return item;
    }
    const r = node.reply;
    const playing = this.playingId() === r.id;
    const item = new vscode.TreeItem(this.preview(r), vscode.TreeItemCollapsibleState.None);
    item.id = r.id;
    item.description = time(r.at);
    item.contextValue = 'reply';
    item.iconPath = new vscode.ThemeIcon(playing ? 'unmute' : 'comment');
    item.tooltip = new vscode.MarkdownString(r.text.length > 900 ? `${r.text.slice(0, 900)}…` : r.text);
    item.command = { command: 'rawi.playReply', title: 'Read Aloud', arguments: [r.id] };
    return item;
  }

  dispose(): void {
    this.unsubscribe();
    this.changed.dispose();
  }

  private preview(r: Reply): string {
    let p = this.previews.get(r.id);
    if (p === undefined) {
      const first = speakableBlocks(r.text, { codeBlocks: 'skip', tables: 'skip' })[0]?.text ?? r.text;
      p = first.length > 90 ? `${first.slice(0, 88).trimEnd()}…` : first;
      this.previews.set(r.id, p);
    }
    return p;
  }
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}
