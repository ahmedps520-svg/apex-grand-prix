import { inflateSync } from 'node:zlib';

/** Minimal PNG decoder (8-bit, non-interlaced) for checking screenshots in tests. */
export interface DecodedImage {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

export function decodePng(png: Buffer): DecodedImage {
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (pos < png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (bitDepth !== 8 || interlace !== 0 || channels === undefined) {
    throw new Error(`Unsupported PNG (depth ${bitDepth}, colour type ${colorType})`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0;
      let v = raw[rowStart + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** How "busy" an image is: a blank or single-colour frame scores near zero on both. */
export function imageStats(image: DecodedImage): {
  luminanceStdDev: number;
  distinctColors: number;
} {
  const { data, channels } = image;
  const colors = new Set<number>();
  let sum = 0;
  let sumSq = 0;
  const pixels = image.width * image.height;
  for (let i = 0; i < pixels; i++) {
    const r = data[i * channels]!;
    const g = channels >= 3 ? data[i * channels + 1]! : r;
    const b = channels >= 3 ? data[i * channels + 2]! : r;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += l;
    sumSq += l * l;
    colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
  }
  const mean = sum / pixels;
  return {
    luminanceStdDev: Math.sqrt(Math.max(sumSq / pixels - mean * mean, 0)),
    distinctColors: colors.size,
  };
}
