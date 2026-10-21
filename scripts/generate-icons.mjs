import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

function createPng(width, height, pixelFn) {
  // CRC32 table
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(4 + 4 + len + 4);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    const crc = crc32(buf.subarray(4, 8 + len));
    buf.writeUInt32BE(crc, 8 + len);
    return buf;
  }

  // PNG Signature
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bits per channel
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // standard filter
  ihdr[12] = 0; // non-interlaced
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // Raw image data with filter byte 0 at start of each row
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    raw[pos++] = 0; // filter byte
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      raw[pos++] = r;
      raw[pos++] = g;
      raw[pos++] = b;
      raw[pos++] = a;
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

// Generate Olympic Pentathlon Laser Pistol Icon
function renderPentathlonIconPixel(x, y, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const rMax = w * 0.46;

  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Squircle background corner radius
  const normX = Math.abs((x - cx) / (w * 0.46));
  const normY = Math.abs((y - cy) / (h * 0.46));
  // Superellipse equation |x|^4 + |y|^4 <= 1
  const inSquircle = (Math.pow(normX, 4) + Math.pow(normY, 4)) <= 1.0;

  if (!inSquircle) {
    return [0, 0, 0, 0]; // Transparent outside
  }

  // Deep Royal Blue background with subtle vertical gradient
  const grad = y / h;
  let bgR = Math.round(26 + grad * 15);
  let bgG = Math.round(54 + grad * 35);
  let bgB = Math.round(138 + grad * 70);

  // Inner Dark Circular Target Backplate
  if (dist <= rMax * 0.88) {
    // Cream target face
    let targetFace = [226, 220, 200, 255]; // #e2dcc8
    
    // Black center (rings 7-10 = hit zone)
    if (dist <= rMax * 0.52) {
      // 10-ring Inner gold ring
      if (dist <= rMax * 0.16) {
        // Red laser dot center!
        if (dist <= rMax * 0.07) {
          return [239, 68, 68, 255]; // Vivid red laser impact
        }
        return [250, 204, 21, 255]; // Golden 10-ring
      }
      
      // Ring boundary lines
      if (Math.abs(dist - rMax * 0.32) <= 1.5 || Math.abs(dist - rMax * 0.44) <= 1.5) {
        return [255, 255, 255, 120];
      }
      return [10, 15, 24, 255]; // Deep target black
    }

    // Outer cream rings lines
    if (Math.abs(dist - rMax * 0.70) <= 1.5 || Math.abs(dist - rMax * 0.86) <= 1.5) {
      return [100, 116, 139, 180];
    }
    return targetFace;
  }

  // Crosshair lines cutting across
  if ((Math.abs(dx) <= 2 || Math.abs(dy) <= 2) && dist <= rMax * 0.88 && dist >= rMax * 0.16) {
    return [37, 99, 235, 180]; // Laser line
  }

  // Outer border highlight
  if (dist >= rMax * 0.88 && dist <= rMax * 0.92) {
    return [250, 204, 21, 255]; // Gold ring accent
  }

  return [bgR, bgG, bgB, 255];
}

const publicDir = path.resolve('public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

console.log('Generating 512x512 app icons...');
const buf512 = createPng(512, 512, renderPentathlonIconPixel);
fs.writeFileSync(path.join(publicDir, 'apple-touch-icon.png'), buf512);
fs.writeFileSync(path.join(publicDir, 'icon-512.png'), buf512);

const buf192 = createPng(192, 192, renderPentathlonIconPixel);
fs.writeFileSync(path.join(publicDir, 'icon-192.png'), buf192);
fs.writeFileSync(path.join(publicDir, 'favicon.png'), buf192);

// Also copy to root assets so directly accessible
fs.writeFileSync(path.resolve('apple-touch-icon.png'), buf512);
fs.writeFileSync(path.resolve('icon-192.png'), buf192);
fs.writeFileSync(path.resolve('icon-512.png'), buf512);

console.log('App icons generated successfully!');
