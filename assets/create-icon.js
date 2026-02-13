const fs = require('fs');

// Create a simple 16x16 PNG with a circle
// PNG header + IHDR + IDAT + IEND for a simple black circle on transparent background

// This creates a basic 16x16 grayscale PNG
const width = 16;
const height = 16;

// Create raw pixel data (grayscale + alpha)
const pixels = [];
for (let y = 0; y < height; y++) {
  pixels.push(0); // filter byte
  for (let x = 0; x < width; x++) {
    const dx = x - 7.5;
    const dy = y - 7.5;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 5.5) {
      pixels.push(0);   // black
      pixels.push(255); // fully opaque
    } else {
      pixels.push(0);   // black
      pixels.push(0);   // transparent
    }
  }
}

const zlib = require('zlib');
const deflated = zlib.deflateSync(Buffer.from(pixels));

function crc32(buf) {
  let crc = 0xffffffff;
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

// PNG signature
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// IHDR chunk
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 4;  // color type (grayscale + alpha)
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  signature,
  chunk('IHDR', ihdr),
  chunk('IDAT', deflated),
  chunk('IEND', Buffer.alloc(0))
]);

fs.writeFileSync('iconTemplate.png', png);
console.log('Created iconTemplate.png');

// Also create @2x version (32x32)
const width2 = 32;
const height2 = 32;
const pixels2 = [];
for (let y = 0; y < height2; y++) {
  pixels2.push(0);
  for (let x = 0; x < width2; x++) {
    const dx = x - 15.5;
    const dy = y - 15.5;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 11) {
      pixels2.push(0);
      pixels2.push(255);
    } else {
      pixels2.push(0);
      pixels2.push(0);
    }
  }
}
const deflated2 = zlib.deflateSync(Buffer.from(pixels2));
const ihdr2 = Buffer.alloc(13);
ihdr2.writeUInt32BE(width2, 0);
ihdr2.writeUInt32BE(height2, 4);
ihdr2[8] = 8;
ihdr2[9] = 4;
const png2 = Buffer.concat([
  signature,
  chunk('IHDR', ihdr2),
  chunk('IDAT', deflated2),
  chunk('IEND', Buffer.alloc(0))
]);
fs.writeFileSync('iconTemplate@2x.png', png2);
console.log('Created iconTemplate@2x.png');
