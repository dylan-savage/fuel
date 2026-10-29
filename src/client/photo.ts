/**
 * Photos for AI quick log, shrunk on the phone before they leave it. An iPhone photo is
 * several MB; the model reads nothing past about 1568 px on the long edge, so that size as
 * a JPEG is a few hundred KB and uploads quickly on a weak signal.
 */
import type { PhotoType } from '../protocol.js';

const LONG_EDGE = 1568;
const QUALITY = 0.82;

export interface PreparedPhoto {
  readonly mediaType: PhotoType;
  readonly base64: string;
}

/** An image element draws with the photo's EXIF orientation applied, which a raw decode does not promise. */
async function load(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result.replace(/^data:[^,]*,/, ''));
      else reject(new Error('could not read the photo'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('could not read the photo'));
    reader.readAsDataURL(blob);
  });
}

export async function preparePhoto(file: Blob): Promise<PreparedPhoto> {
  const image = await load(file);
  const scale = Math.min(1, LONG_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('this browser cannot draw the photo');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (jpeg === null) throw new Error('could not shrink the photo');
  return { mediaType: 'image/jpeg', base64: await base64Of(jpeg) };
}
