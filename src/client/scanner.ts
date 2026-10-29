/**
 * On-device barcode decoding with zxing-wasm. iOS Safari has no native BarcodeDetector, so
 * the ponyfill always decodes in wasm. The wasm is served by the mini and precached by the
 * service worker, so scanning works offline.
 */
import { BarcodeDetector, prepareZXingModule } from 'barcode-detector/ponyfill';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import { parseGtin, RetailFormat, type Gtin } from '../domain/food.js';

let detector: BarcodeDetector | undefined;

function getDetector(): BarcodeDetector {
  if (detector === undefined) {
    // The package defaults to a CDN, which would break scanning offline.
    prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? new URL(wasmUrl, location.href).href : prefix + path),
      },
    });
    detector = new BarcodeDetector({ formats: [...RetailFormat.options] });
  }
  return detector;
}

async function firstGtin(source: Blob | HTMLVideoElement): Promise<Gtin | null> {
  for (const code of await getDetector().detect(source)) {
    const gtin = parseGtin(code.format, code.rawValue);
    if (gtin !== null) return gtin;
  }
  return null;
}

/** Decodes a photo, the fallback when the live camera is unavailable. */
export function decodePhoto(photo: Blob): Promise<Gtin | null> {
  return firstGtin(photo);
}

/**
 * Opens the rear camera on `video` and resolves with the first GTIN read on two
 * consecutive frames, which filters misreads. Always releases the camera.
 */
export async function scanCamera(video: HTMLVideoElement, signal: AbortSignal): Promise<Gtin> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  try {
    video.srcObject = stream;
    await video.play();
    let previous: Gtin | null = null;
    while (!signal.aborted) {
      const gtin = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? await firstGtin(video) : null;
      if (gtin !== null && gtin === previous) return gtin;
      previous = gtin;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new DOMException('scan cancelled', 'AbortError');
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }
}
