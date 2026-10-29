import { useEffect, useRef, useState } from 'preact/hooks';
import type { Gtin } from '../../domain/food.js';
import { decodePhoto, scanCamera } from '../scanner.js';

type ScanState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'camera' }
  | { readonly kind: 'decoding' }
  | { readonly kind: 'found'; readonly gtin: Gtin }
  | { readonly kind: 'failed'; readonly message: string };

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function Scan() {
  const [state, setState] = useState<ScanState>({ kind: 'idle' });
  const video = useRef<HTMLVideoElement>(null);
  const camera = useRef<AbortController | null>(null);

  useEffect(() => () => camera.current?.abort(), []);

  const startCamera = async () => {
    if (video.current === null) return;
    camera.current?.abort();
    const controller = new AbortController();
    camera.current = controller;
    setState({ kind: 'camera' });
    try {
      setState({ kind: 'found', gtin: await scanCamera(video.current, controller.signal) });
    } catch (err) {
      if (camera.current !== controller) return;
      setState(
        controller.signal.aborted ? { kind: 'idle' } : { kind: 'failed', message: `Camera: ${describe(err)}. Try a photo instead.` },
      );
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
      setState(gtin === null ? { kind: 'failed', message: 'No barcode found in that photo.' } : { kind: 'found', gtin });
    } catch (err) {
      setState({ kind: 'failed', message: describe(err) });
    }
  };

  return (
    <section class="scan">
      <video ref={video} playsInline muted hidden={state.kind !== 'camera'} />
      <div class="actions">
        {state.kind === 'camera' ? (
          <button onClick={() => camera.current?.abort()}>Stop</button>
        ) : (
          <button onClick={() => void startCamera()}>Scan with camera</button>
        )}
        <label class="button">
          Take a photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => void onPhoto(e.currentTarget)}
          />
        </label>
      </div>
      {state.kind === 'decoding' && <p>Reading the barcode…</p>}
      {state.kind === 'found' && (
        <p class="gtin">
          GTIN <output data-testid="gtin">{state.gtin}</output>
        </p>
      )}
      {state.kind === 'failed' && <p class="error">{state.message}</p>}
    </section>
  );
}
