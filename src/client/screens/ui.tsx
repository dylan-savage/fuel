/** Small native-feeling building blocks shared by the screens. */
import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import type { Millis } from '../../domain/ids.js';
import { now } from '../clock.js';
import type { Undo } from '../intents.js';
import { Waiting } from './Waiting.js';

/** A screen's large title, with the outbox badge beside it. */
export function TitleBar({ title, children }: { readonly title: string; readonly children?: ComponentChildren }) {
  return (
    <header class="title-bar">
      <h1>{title}</h1>
      <div class="title-bar-end">
        <Waiting />
        {children}
      </div>
    </header>
  );
}

/** Open sheets and alerts, oldest first. One can open over another, and only the top one answers Escape. */
const openModals: object[] = [];

/** Locks page scroll while any modal is open, and closes the top one on Escape. */
function useModal(onClose: () => void) {
  const token = useRef({}).current;

  useEffect(() => {
    openModals.push(token);
    document.body.classList.add('sheet-open');
    return () => {
      openModals.splice(openModals.indexOf(token), 1);
      if (openModals.length === 0) document.body.classList.remove('sheet-open');
    };
  }, [token]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openModals.at(-1) === token) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, token]);
}

/** A bottom sheet. Cancel, Escape or a tap on the backdrop closes it. */
export function Sheet({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ComponentChildren;
}) {
  useModal(onClose);

  return (
    <div
      class="sheet-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section class="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <header class="sheet-bar">
          <button type="button" class="text-button" onClick={onClose}>
            Cancel
          </button>
          <h2>{title}</h2>
          <span />
        </header>
        <div class="sheet-body">{children}</div>
      </section>
    </div>
  );
}

/** The current time, refreshed every `everyMs`, for live timers. */
export function useNow(everyMs: number): Millis {
  const [at, setAt] = useState(now);
  useEffect(() => {
    const timer = setInterval(() => setAt(now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return at;
}

/** Progress as an Activity-style ring, filled clockwise from the top, with content in the middle. */
export function Ring({
  fraction,
  tone,
  size,
  children,
}: {
  readonly fraction: number;
  readonly tone: 'water' | 'fast' | 'done';
  readonly size: number;
  readonly children?: ComponentChildren;
}) {
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.min(1, Math.max(0, fraction));
  return (
    <div class={`ring ${tone}`} style={{ width: `${size}px`, height: `${size}px` }}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="ring-track" cx="50" cy="50" r={radius} />
        {filled > 0 && <circle class="ring-fill" cx="50" cy="50" r={radius} stroke-dasharray={`${circumference * filled} ${circumference}`} />}
      </svg>
      <div class="ring-center">{children}</div>
    </div>
  );
}

export interface AlertAction {
  readonly label: string;
  readonly onClick: () => void;
  /** The recommended choice, drawn bold. */
  readonly preferred?: boolean;
}

/** A centered yes-or-no question, as iOS asks one. Escape picks `onCancel`. */
export function Alert({
  title,
  message,
  actions,
  onCancel,
}: {
  readonly title: string;
  readonly message: string;
  readonly actions: readonly AlertAction[];
  readonly onCancel: () => void;
}) {
  useModal(onCancel);
  return (
    <div class="alert-backdrop">
      <section class="alert" role="alertdialog" aria-modal="true" aria-label={title}>
        <div class="alert-text">
          <h2>{title}</h2>
          <p>{message}</p>
        </div>
        <div class="alert-actions">
          {actions.map((action) => (
            <button type="button" key={action.label} class={action.preferred ? 'preferred' : undefined} onClick={action.onClick}>
              {action.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  return (
    <div class="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button type="button" role="radio" key={option.value} aria-checked={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A labelled numeric field. Text input with a decimal keypad, so iOS never zooms or spins. */
export function NumberField({
  label,
  value,
  onInput,
  unit,
  placeholder,
  invalid = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onInput: (value: string) => void;
  readonly unit?: string;
  readonly placeholder?: string;
  readonly invalid?: boolean;
}) {
  return (
    <label class={invalid ? 'field invalid' : 'field'}>
      <span class="field-label">{label}</span>
      <input
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder={placeholder ?? ''}
        aria-invalid={invalid}
        onInput={(event) => onInput(event.currentTarget.value)}
      />
      {unit !== undefined && <span class="field-unit">{unit}</span>}
    </label>
  );
}

export function TextField({
  label,
  value,
  onInput,
  placeholder,
}: {
  readonly label: string;
  readonly value: string;
  readonly onInput: (value: string) => void;
  readonly placeholder?: string;
}) {
  return (
    <label class="field">
      <span class="field-label">{label}</span>
      <input autoComplete="off" value={value} placeholder={placeholder ?? ''} onInput={(event) => onInput(event.currentTarget.value)} />
    </label>
  );
}

export interface ToastMessage {
  readonly text: string;
  readonly undo?: Undo;
}

const ToastContext = createContext<(message: ToastMessage) => void>(() => undefined);

export function useToast(): (message: ToastMessage) => void {
  return useContext(ToastContext);
}

/** One toast at a time, above the tab bar. A new message replaces the old one. */
export function ToastHost({ children }: { readonly children: ComponentChildren }) {
  const [toast, setToast] = useState<(ToastMessage & { readonly id: number }) | null>(null);
  const next = useRef(0);
  const show = useCallback((message: ToastMessage) => setToast({ ...message, id: ++next.current }), []);

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div class="toast" role="status" key={toast.id}>
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              type="button"
              class="text-button"
              onClick={() => {
                setToast(null);
                void toast.undo?.();
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </ToastContext.Provider>
  );
}

const ICONS = {
  diary: 'M5 4.5h14M5 9.5h14M5 14.5h9M5 19.5h6',
  add: 'M12 5v14M5 12h14',
  scan: 'M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M8 8v8M11 8v8M14 8v8M17 8v8',
  goal: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 12h.01',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronRight: 'M9 5l7 7-7 7',
  plus: 'M12 6v12M6 12h12',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  drop: 'M12 3.5c3.3 4.2 5.5 7.4 5.5 10.3a5.5 5.5 0 0 1-11 0c0-2.9 2.2-6.1 5.5-10.3Z',
  timer: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM12 9v4l2.5 2M10 2.5h4',
} as const;

export function Icon({ name }: { readonly name: keyof typeof ICONS }) {
  return (
    <svg class={`icon icon-${name}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}
