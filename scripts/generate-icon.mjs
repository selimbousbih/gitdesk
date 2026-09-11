import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';

const size = 512;
const data = Buffer.alloc(size * (size * 4 + 1));
const distance = (x, y, a, b) => Math.hypot(x - a, y - b);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    const round = Math.hypot(Math.max(Math.abs(x - 256) - 128, 0), Math.max(Math.abs(y - 256) - 128, 0));
    const alpha = Math.max(0, Math.min(1, 113 - round));
    const mix = (x + y) / 1024;
    let color = [139 - 56 * mix, 122 - 53 * mix, 249 - 51 * mix];
    const branch = (Math.abs(x - 172) < 14 && y >= 148 && y <= 364)
      || (x >= 172 && x <= 276 && Math.abs(y - 264) < 14)
      || (x >= 276 && y >= 200 && Math.abs(distance(x, y, 276, 200) - 64) < 14)
      || (Math.abs(x - 340) < 14 && y >= 148 && y <= 200);
    if (branch) color = [255, 255, 255];
    for (const [cx, cy] of [[172, 148], [172, 364], [340, 148]]) {
      const d = distance(x, y, cx, cy);
      if (d < 36) color = [255, 255, 255];
      if (d < 15) color = [113, 96, 224];
    }
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = alpha * 255;
  }
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const payload = Buffer.concat([Buffer.from(type), bytes]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([header, payload, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8;
ihdr[9] = 6;
await writeFile(new URL('../assets/icon.png', import.meta.url), Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(data)),
  chunk('IEND', Buffer.alloc(0)),
]));
