import { useEffect, useRef, useState } from 'preact/hooks';
import type { Slot } from '../../domain/diary.js';
import { defaultQuantity, parseGtin, snapshotOf, type Gtin } from '../../domain/food.js';
import { lookupFood } from '../api.js';
import { decodePhoto, scanCamera } from '../scanner.js';
import { foodWithBarcode, useRead } from '../views.js';
import { useLogFlow, type OnLogged } from './flow.js';
import { Sheet } from './ui.js';

type ScanState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'camera' }
  | { readonly kind: 'decoding' }
  | { readonly kind: 'resolving'; readonly gtin: Gtin }
  | { readonly kind: 'found'; readonly gtin: Gtin }
  | { readonly kind: 'unknown'; readonly gtin: Gtin; readonly why: 'not_found' | 'offline' | 'unavailable' }
  | { readonly kind: 'failed'; readonly message: string };

const UNKNOWN_TEXT: Readonly<Record<Extract<ScanState, { kind: 'unknown' }>['why'], string>> = {
  not_found: 'Open Food Facts does not know this product.',
  offline: 'The mini cannot be reached, so this product cannot be looked up now.',
  unavailable: 'Open Food Facts did not answer.',
};

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A typed barcode: any retail length, checked the same way as a decoded one. */
function typedGtin(text: string): Gtin | null {
  const digits = text.replace(/\D/g, '');
  return parseGtin(digits.length === 8 ? 'ean_8' : digits.length === 12 ? 'upc_a' : 'ean_13', digits);
}

export interface ScanProps {
  readonly slot: Slot;
  readonly onLogged: OnLogged;
  readonly onClose: () => void;
}

export function Scan({ slot, onLogged, onClose }: ScanProps) {
  const [state, setState] = useState<ScanState>({ kind: 'idle' });
  const [typed, setTyped] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const camera = useRef<AbortController | null>(null);
  const flow = useLogFlow(slot, onLogged);
  const read = useRead();

  useEffect(() => () => camera.current?.abort(), []);

  /** Library first, so a known product logs with no network; then Open Food Facts through the mini. */
  const resolve = async (gtin: Gtin) => {
    setState({ kind: 'resolving', gtin });
    const food = await read((r) => foodWithBarcode(r, gtin));
    if (food !== undefined) {
      setState({ kind: 'found', gtin });
      flow.open({ kind: 'food', food: snapshotOf(food), quantity: defaultQuantity(food) });
      return;
    }
    const result = await lookupFood({ kind: 'gtin', gtin });
    if (result.ok && result.value.kind === 'found') {
      setState({ kind: 'found', gtin });
      flow.open({ kind: 'confirm', candidate: result.value.candidate });
      return;
    }
    const why = result.ok ? 'not_found' : result.reason === 'offline' ? 'offline' : 'unavailable';
    setState({ kind: 'unknown', gtin, why });
  };

  const startCamera = async () => {
    if (video.current === null) return;
    camera.current?.abort();
    const controller = new AbortController();
    camera.current = controller;
    setState({ kind: 'camera' });
    try {
      await resolve(await scanCamera(video.current, controller.signal));
    } catch (err) {
      if (camera.current !== controller) return;
      setState(controller.signal.aborted ? { kind: 'idle' } : { kind: 'failed', message: `Camera: ${describe(err)}. Try a photo instead.` });
    }
  };

  const onPhoto = async (input: HTMLInputElement) => {
    const photo = input.files?.[0];
    input.value = '';
    if (photo === undefined) return;
    camera.current?.abort();
    camera.current = null;
    setState({ kind: 'decoding' });
    try {
      const gtin = await decodePhoto(photo);
      if (gtin === null) setState({ kind: 'failed', message: 'No barcode found in that photo.' });
      else await resolve(gtin);
    } catch (err) {
      setState({ kind: 'failed', message: describe(err) });
    }
  };

  const typedValue = typedGtin(typed);
  const gtin = 'gtin' in state ? state.gtin : null;

  return (
    <>
      <Sheet title="Scan" onClose={onClose}>
      <video class="scan-video" ref={video} playsInline muted hidden={state.kind !== 'camera'} />
      <div class="actions-row">
        {state.kind === 'camera' ? (
          <button type="button" onClick={() => camera.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="button" class="primary" onClick={() => void startCamera()}>
            Scan with camera
          </button>
        )}
        <label class="button">
          Take a photo
          <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => void onPhoto(e.currentTarget)} />
        </label>
      </div>

      <form
        class="group typed-barcode"
        onSubmit={(event) => {
          event.preventDefault();
          if (typedValue !== null) void resolve(typedValue);
        }}
      >
        <label class="field">
          <span class="field-label">Barcode</span>
          <input
            inputMode="numeric"
            autoComplete="off"
            aria-label="Barcode number"
            placeholder="Type the digits"
            value={typed}
            onInput={(event) => setTyped(event.currentTarget.value)}
          />
        </label>
        <button type="submit" class="row-button" disabled={typedValue === null}>
          Look up
        </button>
      </form>

      {state.kind === 'decoding' && <p class="empty">Reading the barcode…</p>}
      {gtin !== null && (
        <p class="gtin">
          GTIN <output data-testid="gtin">{gtin}</output>
        </p>
      )}
      {state.kind === 'resolving' && <p class="empty">Looking it up…</p>}
      {state.kind === 'unknown' && (
        <div class="card unknown">
          <p>{UNKNOWN_TEXT[state.why]}</p>
          <div class="actions-row">
            <button type="button" onClick={() => flow.open({ kind: 'editor', seed: { kind: 'new', barcodes: [state.gtin] } })}>
              Create food
            </button>
            <button type="button" onClick={() => flow.open({ kind: 'quick-add' })}>
              Quick add
            </button>
          </div>
        </div>
      )}
      {state.kind === 'failed' && <p class="error">{state.message}</p>}
      </Sheet>
      {flow.sheet}
    </>
  );
}
