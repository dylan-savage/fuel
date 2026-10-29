/**
 * Asking the mini's AI to read a meal, shared by the Add screen's quick log and the Scan
 * screen's label photo. AI needs the mini, so it is off, with the reason, while the mini
 * cannot be reached, and a request is never queued.
 */
import { useEffect, useState } from 'preact/hooks';
import type { FoodCandidate } from '../../domain/food.js';
import type { Draft, FoodHint } from '../../domain/quicklog.js';
import type { AiAnswer, AiFailure, AiParseRequest } from '../../protocol.js';
import { parseWithAi, type OnlineFailure } from '../api.js';
import { preparePhoto } from '../photo.js';
import { useSyncState } from '../views.js';

export type AiSubject = 'text' | 'plate' | 'label';

/** Why AI has no answer: the mini's reasons, plus a photo the phone could not read. */
export type AiWhy = OnlineFailure | AiFailure | 'bad_photo';

export type AiState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending'; readonly subject: AiSubject }
  | { readonly kind: 'failed'; readonly subject: AiSubject; readonly why: AiWhy };

export const UNREACHABLE_TEXT = 'AI needs the mini, which cannot be reached right now.';

export function whyText(why: AiWhy, subject: AiSubject): string {
  switch (why) {
    case 'offline':
      return UNREACHABLE_TEXT;
    case 'ai_unconfigured':
      return 'AI is not set up on the mini yet. It needs an Anthropic API key.';
    case 'unavailable':
    case 'ai_unavailable':
      return 'Claude did not answer. Try again in a moment.';
    case 'ai_timeout':
      return 'Claude took too long. Try again.';
    case 'ai_refused':
      return 'Claude would not read this one. Try describing it another way.';
    case 'bad_response':
    case 'ai_unreadable':
      return "Claude's answer could not be read. Try again.";
    case 'ai_nothing_found':
      return subject === 'label' ? 'No nutrition label found in that photo.' : 'No food found in that. Say what you ate and roughly how much.';
    case 'bad_photo':
      return 'That photo could not be opened. Try another.';
  }
}

const SENDING_TEXT: Readonly<Record<AiSubject, string>> = {
  text: 'Reading your meal…',
  plate: 'Looking at your plate…',
  label: 'Reading the label…',
};

/** The browser's network state and the last sync together: false once either says the mini is out of reach. */
function useMiniReachable(): boolean {
  const sync = useSyncState();
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online && sync?.kind !== 'offline';
}

export function useAi() {
  const [state, setState] = useState<AiState>({ kind: 'idle' });
  const reachable = useMiniReachable();

  const ask = async (subject: AiSubject, build: () => Promise<AiParseRequest>): Promise<AiAnswer | null> => {
    setState({ kind: 'sending', subject });
    let req: AiParseRequest;
    try {
      req = await build();
    } catch {
      setState({ kind: 'failed', subject, why: 'bad_photo' });
      return null;
    }
    const result = await parseWithAi(req);
    if (!result.ok) {
      setState({ kind: 'failed', subject, why: result.reason });
      return null;
    }
    setState({ kind: 'idle' });
    return result.value;
  };

  const askPhoto = (subject: 'plate' | 'label', file: Blob, foods: readonly FoodHint[]) =>
    ask(subject, async () => ({ kind: 'photo', subject, ...(await preparePhoto(file)), foods: [...foods] }));

  return { state, reachable, ask, askPhoto, busy: state.kind === 'sending' };
}

/** What the AI's state says under its controls, if anything. */
export function AiStatus({ state, reachable }: { readonly state: AiState; readonly reachable: boolean }) {
  if (!reachable) return <p class="hint">{UNREACHABLE_TEXT}</p>;
  switch (state.kind) {
    case 'idle':
      return null;
    case 'sending':
      return (
        <p class="hint" role="status">
          {SENDING_TEXT[state.subject]}
        </p>
      );
    case 'failed':
      return (
        <p class="hint warn" role="alert">
          {whyText(state.why, state.subject)}
        </p>
      );
  }
}

/** A photo button: a label wrapping a hidden file input, so the camera or the library can answer it. */
export function PhotoButton({
  label,
  disabled,
  capture = false,
  primary = false,
  onPhoto,
}: {
  readonly label: string;
  readonly disabled: boolean;
  /** Open the camera straight away, for a label in hand. */
  readonly capture?: boolean;
  readonly primary?: boolean;
  readonly onPhoto: (file: File) => void;
}) {
  return (
    <label class={primary ? 'button primary' : 'button'} aria-disabled={disabled}>
      {label}
      <input
        type="file"
        accept="image/*"
        aria-label={label}
        disabled={disabled}
        hidden
        {...(capture ? { capture: 'environment' } : {})}
        onChange={(event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          input.value = '';
          if (file !== undefined) onPhoto(file);
        }}
      />
    </label>
  );
}

/** The Add screen's AI quick log: describe a meal or photograph a plate or a label. */
export function QuickLog({
  foods,
  onDrafts,
  onLabel,
}: {
  readonly foods: readonly FoodHint[];
  readonly onDrafts: (drafts: readonly Draft[]) => void;
  readonly onLabel: (candidate: FoodCandidate) => void;
}) {
  const [text, setText] = useState('');
  const ai = useAi();
  const off = !ai.reachable || ai.busy;

  const open = (answer: AiAnswer | null): boolean => {
    if (answer === null) return false;
    if (answer.kind === 'drafts') onDrafts(answer.drafts);
    else onLabel(answer.candidate);
    return true;
  };

  return (
    <section class="quick-log" aria-label="AI quick log">
      <form
        class="quick-log-text"
        onSubmit={(event) => {
          event.preventDefault();
          const meal = text.trim();
          if (meal.length < 2) return;
          void ai.ask('text', () => Promise.resolve({ kind: 'text', text: meal, foods: [...foods] })).then((answer) => {
            if (open(answer)) setText('');
          });
        }}
      >
        <input
          aria-label="Describe what you ate"
          placeholder="2 eggs and my usual oats"
          enterKeyHint="send"
          autoComplete="off"
          disabled={off}
          value={text}
          onInput={(event) => setText(event.currentTarget.value)}
        />
        <button type="submit" class="primary" disabled={off || text.trim().length < 2}>
          Log with AI
        </button>
      </form>
      <div class="actions-row">
        <PhotoButton label="Plate photo" disabled={off} onPhoto={(file) => void ai.askPhoto('plate', file, foods).then(open)} />
        <PhotoButton label="Label photo" disabled={off} onPhoto={(file) => void ai.askPhoto('label', file, []).then(open)} />
      </div>
      <AiStatus state={ai.state} reachable={ai.reachable} />
    </section>
  );
}
