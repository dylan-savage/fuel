/**
 * On-device barcode decoding. Works offline: the decoder and its wasm are part of the
 * precached app shell.
 */
import { todo } from '../todo.js';
import type { Gtin } from '../domain/ids.js';

/**
 * Points the `barcode-detector` package's zxing-wasm at /zxing_reader.wasm on our own
 * origin instead of its CDN default, so the service worker can precache it. Call once at
 * startup. The package's override export name differs across major versions; pin the
 * version and check its README when implementing.
 */
export function configureScanner(): void {
  return todo('configureScanner');
}

/**
 * Opens the rear camera (getUserMedia, facingMode 'environment') on the given video element
 * and decodes ean_13, upc_a and ean_8 with BarcodeDetector: native when WebKit provides it,
 * the zxing-wasm polyfill otherwise. Resolves with the first code that parseGtin accepts on
 * two consecutive frames (filters misreads), then stops the stream. Rejects on abort or
 * camera denial.
 */
export function scanBarcode(video: HTMLVideoElement, signal: AbortSignal): Promise<Gtin> {
  return todo(`scanBarcode(${video.tagName}, ${signal.aborted})`);
}
