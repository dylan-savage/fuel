/**
 * Runs the same decoder the phone runs (barcode-detector over zxing-wasm) on barcodes that
 * zxing draws, so the digits parseGtin receives are the decoder's real output.
 */
import { readFileSync } from 'node:fs';
import { BarcodeDetector, ZXING_WASM_VERSION } from 'barcode-detector/ponyfill';
import { writeBarcode, type WriteInputBarcodeFormat } from 'zxing-wasm/writer';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseGtin, RetailFormat } from '../src/domain/food.js';

beforeAll(() => {
  // The ponyfill builds bounding boxes with a browser class Node lacks.
  Object.defineProperty(globalThis, 'DOMRectReadOnly', {
    configurable: true,
    value: class {
      constructor(
        readonly x = 0,
        readonly y = 0,
        readonly width = 0,
        readonly height = 0,
      ) {}
    },
  });
});

async function scan(format: WriteInputBarcodeFormat, text: string) {
  const { image, error } = await writeBarcode(text, { format, scale: 3 });
  if (!image) throw new Error(error);
  const [code] = await new BarcodeDetector({ formats: [...RetailFormat.options] }).detect(image);
  if (!code) throw new Error(`nothing decoded for ${format}`);
  return parseGtin(code.format, code.rawValue);
}

describe('decoded retail barcodes normalize to GTIN-13', () => {
  it.each([
    ['EAN13', '4006381333931', '4006381333931'],
    ['UPCA', '049000000443', '0049000000443'],
    ['EAN8', '96385074', '0000096385074'],
    ['UPCE', '01234565', '0012345000065'],
  ] satisfies [WriteInputBarcodeFormat, string, string][])('%s %s', async (format, printed, gtin) => {
    expect(await scan(format, printed)).toBe(gtin);
  });
});

it('self-hosts the wasm that matches the decoder glue', () => {
  const manifest = readFileSync(new URL('../node_modules/zxing-wasm/package.json', import.meta.url), 'utf8');
  const { version } = z.object({ version: z.string() }).parse(JSON.parse(manifest));
  expect(version).toBe(ZXING_WASM_VERSION);
});
