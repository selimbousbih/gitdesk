import { useMemo, useState, type ReactNode } from 'react';
import { FileCode2, FileWarning, Image, TextSelect } from 'lucide-react';
import type { DiffResult } from '../shared/api';
import { EmptyState } from './ui';

export interface DiffLine {
  kind: 'header' | 'hunk' | 'addition' | 'deletion' | 'context' | 'note';
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
}

export function parseDiff(text: string): DiffLine[] {
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldNumber = Number(hunk[1]); newNumber = Number(hunk[2]); inHunk = true;
      return { kind: 'hunk', text, oldNumber: null, newNumber: null };
    }
    if (text.startsWith('diff --git')) inHunk = false;
    if (inHunk && text.startsWith('+')) return { kind: 'addition', text: text.slice(1), oldNumber: null, newNumber: newNumber++ };
    if (inHunk && text.startsWith('-')) return { kind: 'deletion', text: text.slice(1), oldNumber: oldNumber++, newNumber: null };
    if (inHunk && text.startsWith(' ')) return { kind: 'context', text: text.slice(1), oldNumber: oldNumber++, newNumber: newNumber++ };
    return { kind: text.startsWith('\\') ? 'note' : 'header', text, oldNumber: null, newNumber: null };
  });
}

const keywords = /^(?:const|let|var|function|return|export|import|from|default|class|extends|interface|type|async|await|if|else|for|while|switch|case|break|continue|throw|try|catch|finally|new|this|public|private|static|void|def|self|lambda|in|not|and|or|with|as|pass|fn|pub|use|impl|struct|enum|mod|match|package|func|defer|go|select|namespace|using|include|true|false|null|undefined|None|True|False)$/;
const tokenPattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$|#.*$|\b[A-Za-z_]\w*\b|\b\d+(?:\.\d+)?\b)/g;

function highlight(text: string): ReactNode {
  if (text.length > 2500) return text;
  let previous = 0;
  const parts: ReactNode[] = [];
  for (const match of text.matchAll(tokenPattern)) {
    const start = match.index;
    if (start > previous) parts.push(text.slice(previous, start));
    const token = match[0];
    const type = /^[ "'`]/.test(token) ? 'string'
      : token.startsWith('//') || token.startsWith('#') ? 'comment'
        : /^\d/.test(token) ? 'number' : keywords.test(token) ? 'keyword' : null;
    parts.push(type ? <span key={start} className={`syntax-${type}`}>{token}</span> : token);
    previous = start + token.length;
  }
  if (previous < text.length) parts.push(text.slice(previous));
  return parts;
}

export function DiffView({ diff }: { diff: DiffResult }) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => parseDiff(diff.text), [diff.text]);
  const additions = lines.filter(line => line.kind === 'addition').length;
  const deletions = lines.filter(line => line.kind === 'deletion').length;
  const limit = expanded ? 12000 : 1500;
  if (diff.binary) return <EmptyState icon={<Image size={30} />} title="Binary file">
    <p>This file cannot be displayed as a text diff. Use your editor or file manager to inspect it.</p>
    {diff.message && <p>{diff.message}</p>}
  </EmptyState>;
  if (!diff.text && diff.tooLarge) return <EmptyState icon={<FileWarning size={30} />} title="This diff is too large to display">
    <p>{diff.message ?? 'Open this file in your editor to review the changes safely.'}</p>
  </EmptyState>;
  if (!diff.text) return <EmptyState icon={<TextSelect size={30} />} title="No textual changes">
    <p>{diff.message ?? 'There are no changes in this view. Try the other diff source for staged or working-tree changes.'}</p>
  </EmptyState>;
  return <div className="diff-view">
    <div className="diff-summary"><span><FileCode2 size={13} /> Unified diff</span>
      <span><b className="text-success">+{additions}</b><b className="text-danger">−{deletions}</b></span>
    </div>
    {(diff.tooLarge || lines.length > limit) && <div className="diff-notice">
      <FileWarning size={15} /><span>{diff.tooLarge ? diff.message ?? 'The engine truncated this large diff.' : `Showing ${Math.min(limit, lines.length).toLocaleString()} of ${lines.length.toLocaleString()} lines.`}</span>
      {!expanded && lines.length > 1500 && <button className="text-button" onClick={() => setExpanded(true)}>Show more (up to 12,000)</button>}
    </div>}
    <div className="diff-scroll" tabIndex={0} aria-label={`Code diff for ${diff.path}`}>
      <table className="diff-table" aria-label="Unified diff"><tbody>
        {lines.slice(0, limit).map((line, index) => <tr key={index} className={`diff-line ${line.kind}`}>
          <td className="line-number" aria-label={line.oldNumber === null ? undefined : `Old line ${line.oldNumber}`}>{line.oldNumber}</td>
          <td className="line-number" aria-label={line.newNumber === null ? undefined : `New line ${line.newNumber}`}>{line.newNumber}</td>
          <td className="diff-sign" aria-hidden="true">{line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ''}</td>
          <td className="line-code"><code>{line.kind === 'header' || line.kind === 'hunk' || line.kind === 'note' ? line.text : highlight(line.text)}</code></td>
        </tr>)}
      </tbody></table>
    </div>
  </div>;
}
