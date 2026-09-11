import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, Check, ChevronDown, LoaderCircle, X } from 'lucide-react';
import type { AppError } from '../shared/api';

export function Brand({ large = false }: { large?: boolean }) {
  return <span className={`brand-mark${large ? ' large' : ''}`} aria-hidden="true">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M7 6v11m0-5c7 0 10-1 10-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="7" cy="6" r="2.4" fill="currentColor" />
      <circle cx="7" cy="18" r="2.4" fill="currentColor" />
      <circle cx="17" cy="6" r="2.4" fill="currentColor" />
    </svg>
  </span>;
}

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string; children: ReactNode;
}) {
  return <button type="button" title={label} aria-label={label} className={`icon-button ${className}`} {...props}>{children}</button>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="loading-label" role="status"><LoaderCircle size={16} className="spin" />{label}</span>;
}

export function ErrorBox({ error, retry }: { error: AppError; retry?: () => void }) {
  return <div className="error-box" role="alert">
    <AlertCircle size={18} />
    <div><strong>{error.message}</strong>{error.detail && <pre>{error.detail}</pre>}
      <span className="error-code">{error.code}</span>
      {retry && <button className="button small" onClick={retry}>Try again</button>}
    </div>
  </div>;
}

const dialogStack: symbol[] = [];
const focusable = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]';

export function Dialog({ title, subtitle, onClose, children, wide = false, closingDisabled = false }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean; closingDisabled?: boolean;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const disabledRef = useRef(closingDisabled);
  closeRef.current = onClose;
  disabledRef.current = closingDisabled;
  useEffect(() => {
    const token = Symbol();
    dialogStack.push(token);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const first = panel.current?.querySelector<HTMLElement>('[data-autofocus]') ??
        panel.current?.querySelector<HTMLElement>(focusable);
      (first ?? panel.current)?.focus();
    });
    const keydown = (event: KeyboardEvent) => {
      if (dialogStack.at(-1) !== token) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!disabledRef.current) closeRef.current();
      }
      if (event.key === 'Tab') {
        const nodes = [...(panel.current?.querySelectorAll<HTMLElement>(focusable) ?? [])]
          .filter(node => node.getClientRects().length > 0);
        const first = nodes[0];
        const last = nodes.at(-1);
        if (!first) { event.preventDefault(); panel.current?.focus(); return; }
        if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      cancelAnimationFrame(frame);
      dialogStack.splice(dialogStack.indexOf(token), 1);
      document.removeEventListener('keydown', keydown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget && !closingDisabled) onClose();
  }}>
    <div ref={panel} className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
      <header className="dialog-heading"><div><h2 id={id}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <IconButton label="Close dialog" onClick={onClose} disabled={closingDisabled}><X size={18} /></IconButton>
      </header>
      {children}
    </div>
  </div>;
}

export interface ConfirmOptions { title: string; message: string; detail?: string; confirmLabel?: string; danger?: boolean }
export type Confirm = (options: ConfirmOptions) => Promise<boolean>;

export function useConfirmation() {
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (confirmed: boolean) => void } | null>(null);
  const confirm: Confirm = options => new Promise(resolve => setPending({ options, resolve }));
  const finish = (value: boolean) => { pending?.resolve(value); setPending(null); };
  const confirmation = pending && <Dialog title={pending.options.title} onClose={() => finish(false)}>
    <div className="dialog-body"><p className="confirmation-message">{pending.options.message}</p>
      {pending.options.detail && <p className="muted preserve-lines">{pending.options.detail}</p>}</div>
    <footer className="dialog-footer">
      <button className="button" data-autofocus onClick={() => finish(false)}>Cancel</button>
      <button className={`button ${pending.options.danger ? 'danger' : 'primary'}`} onClick={() => finish(true)}>
        {pending.options.confirmLabel ?? 'Confirm'}
      </button>
    </footer>
  </Dialog>;
  return { confirm, confirmation };
}

export function Menu({ label, children, trigger, className = '', align = 'left', onOpenChange }: {
  label: string; children: ReactNode; trigger?: ReactNode; className?: string; align?: 'left' | 'right'; onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const id = useId();
  const change = (next: boolean, restore = false) => {
    setOpen(next); onOpenChange?.(next);
    if (restore) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      (content.current?.querySelector<HTMLElement>('[data-autofocus]') ?? content.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])'))?.focus();
    });
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) change(false); };
    document.addEventListener('pointerdown', outside);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('pointerdown', outside); };
  }, [open]);
  return <div className={`menu-root ${className}`} ref={root} onKeyDown={event => {
    if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); change(true); return; }
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); change(false, true); }
    if (event.key === 'Tab') { change(false); return; }
    if (event.target instanceof HTMLInputElement) return;
    const items = [...(content.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault(); items[next]?.focus();
  }}>
    <button ref={button} className="menu-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => change(!open)}>
      {trigger ?? <>{label}<ChevronDown size={12} /></>}
    </button>
    {open && <div ref={content} id={id} role="menu" aria-label={label} className={`popover align-${align}`} onClick={event => {
      if ((event.target as HTMLElement).closest('[role="menuitem"]')) change(false, true);
    }}>{children}</div>}
  </div>;
}

export function MenuItem({ children, icon, checked, shortcut, danger = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode; icon?: ReactNode; checked?: boolean; shortcut?: string; danger?: boolean;
}) {
  return <button type="button" role="menuitem" className={`menu-item${danger ? ' text-danger' : ''}`} {...props}>
    {icon && <span className="menu-icon">{icon}</span>}<span className="menu-item-label">{children}</span>
    {checked && <Check size={14} />}{shortcut && <kbd>{shortcut}</kbd>}
  </button>;
}

export function EmptyState({ icon, title, children, compact = false }: {
  icon: ReactNode; title: string; children?: ReactNode; compact?: boolean;
}) {
  return <div className={`empty-state${compact ? ' compact' : ''}`}><div className="empty-icon">{icon}</div>
    <h2>{title}</h2><div className="empty-description">{children}</div></div>;
}

export function shortPath(path: string) {
  const parts = path.split('/');
  return { name: parts.pop() ?? path, directory: parts.join('/') };
}

export function formatDate(date: string, short = false) {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleString(undefined, short
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
