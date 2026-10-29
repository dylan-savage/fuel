/** Small native-feeling building blocks shared by the screens. */
import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('sheet-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('sheet-open');
    };
  }, [onClose]);

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
} as const;

export function Icon({ name }: { readonly name: keyof typeof ICONS }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}
