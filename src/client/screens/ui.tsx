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

interface RowParts {
  readonly name: ComponentChildren;
  /** At most one muted line. */
  readonly detail?: ComponentChildren;
  /** A value at the right edge. */
  readonly end?: ComponentChildren;
}

function RowBody({ name, detail, end, chevron }: RowParts & { readonly chevron: boolean }) {
  return (
    <>
      <span class="row-name">{name}</span>
      {detail !== undefined && <span class="row-detail">{detail}</span>}
      {(end !== undefined || chevron) && (
        <span class="row-end">
          {end !== undefined && <span class="row-value">{end}</span>}
          {chevron && <Icon name="chevronRight" />}
        </span>
      )}
    </>
  );
}

/** The one row, for inside a `.list`: a name, at most one muted line and a value or chevron. A button once it has `onClick`, and plain text before that. */
export function Row({
  name,
  detail,
  end,
  chevron = false,
  disabled = false,
  onClick,
}: RowParts & { readonly chevron?: boolean; readonly disabled?: boolean; readonly onClick?: () => void }) {
  const body = <RowBody name={name} detail={detail} end={end} chevron={chevron} />;
  return onClick === undefined ? (
    <div class="row">{body}</div>
  ) : (
    <button type="button" class="row" disabled={disabled} onClick={onClick}>
      {body}
    </button>
  );
}

/** A row that opens in place, for words on request. `clamp` holds the name to one line until it opens, for a name that is the whole text. `open` is how it starts, and a tap has the last word after that. */
export function ExpandRow({
  name,
  detail,
  end,
  clamp = false,
  open = false,
  children,
}: RowParts & { readonly clamp?: boolean; readonly open?: boolean; readonly children?: ComponentChildren }) {
  return (
    <details class={clamp ? 'expand clamp' : 'expand'} open={open}>
      <summary class="row">
        <RowBody name={name} detail={detail} end={end} chevron={!clamp} />
      </summary>
      {children !== undefined && <div class="expand-body">{children}</div>}
    </details>
  );
}

/** One of a quiet row of numbers, opening the sheet that holds its actions. */
export function Stat({ label, value, onClick }: { readonly label: string; readonly value: ComponentChildren; readonly onClick: () => void }) {
  return (
    <button type="button" class="stat" onClick={onClick}>
      <span class="stat-label">{label}</span>
      <span class="stat-value">{value}</span>
    </button>
  );
}

/** A section of the diary: a heading with its calories and a small plus, over its rows. With no calories yet it is one quiet line. A tap on the heading opens what else it can do. */
export function DaySection({
  name,
  total,
  addLabel,
  onAdd,
  onOpen,
  children,
}: {
  readonly name: string;
  readonly total: string | null;
  readonly addLabel: string;
  readonly onAdd: () => void;
  readonly onOpen?: () => void;
  readonly children?: ComponentChildren;
}) {
  const heading = (
    <>
      {name}
      {total !== null && <span class="day-section-total">{total} kcal</span>}
    </>
  );
  return (
    <section class={total === null ? 'day-section quiet' : 'day-section'} aria-label={name}>
      <header class="day-section-head">
        <h2>
          {onOpen === undefined ? (
            heading
          ) : (
            <button type="button" aria-label={total === null ? `${name} options` : `${name} options, ${total} kcal`} onClick={onOpen}>
              {heading}
            </button>
          )}
        </h2>
        <button type="button" class="icon-button" aria-label={addLabel} onClick={onAdd}>
          <Icon name="plus" />
        </button>
      </header>
      {total !== null && <ul class="list foods">{children}</ul>}
    </section>
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
  closeLabel = 'Cancel',
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly closeLabel?: string;
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
            {closeLabel}
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
  quiet = false,
}: {
  readonly label: string;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  /** Text with the choice in bold, for a control that should not compete with what it controls. */
  readonly quiet?: boolean;
}) {
  return (
    <div class={quiet ? 'segmented quiet' : 'segmented'} role="radiogroup" aria-label={label}>
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
  autoFocus = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onInput: (value: string) => void;
  readonly unit?: string;
  readonly placeholder?: string;
  readonly invalid?: boolean;
  readonly autoFocus?: boolean;
}) {
  return (
    <label class={invalid ? 'field invalid' : 'field'}>
      <span class="field-label">{label}</span>
      <input
        inputMode="decimal"
        autoFocus={autoFocus}
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

/** Several lines of free text, labelled above. */
export function NoteField({
  label,
  value,
  onInput,
  maxLength,
  labelClass = 'field-label',
  placeholder,
}: {
  readonly label: string;
  readonly value: string;
  readonly onInput: (value: string) => void;
  readonly maxLength: number;
  /** `section-heading` where the label heads its section, `sr-only` where a control beside it already says it. */
  readonly labelClass?: string;
  readonly placeholder?: string;
}) {
  return (
    <label class="note-field">
      <span class={labelClass}>{label}</span>
      <textarea rows={3} maxLength={maxLength} value={value} placeholder={placeholder ?? ''} onInput={(event) => onInput(event.currentTarget.value)} />
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
  train: 'M3 10v4M6.5 7v10M17.5 7v10M21 10v4M6.5 12h11',
  goal: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 12h.01',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronRight: 'M9 5l7 7-7 7',
  plus: 'M12 6v12M6 12h12',
  close: 'M8 8l8 8M16 8l-8 8',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  timer: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM12 9v4l2.5 2M10 2.5h4',
} as const;

export function Icon({ name }: { readonly name: keyof typeof ICONS }) {
  return (
    <svg class={`icon icon-${name}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}
