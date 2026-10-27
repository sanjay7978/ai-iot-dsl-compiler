// qr.js — a small QR code encoder (byte mode, error correction level M,
// versions 1-10), written from the QR specification so the page needs no library.

// ---- Reed-Solomon over GF(256) with polynomial 0x11D ----------------------------------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function generator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function ecc(data, n) {
  const g = generator(n);
  const res = data.concat(new Array(n).fill(0));
  for (let i = 0; i < data.length; i++) {
    const c = res[i];
    if (c) for (let j = 0; j < g.length; j++) res[i + j] ^= mul(g[j], c);
  }
  return res.slice(data.length);
}

// ---- version tables (level M) ----------------------------------------------------------
// version: [EC codewords per block, [[block count, data codewords per block], ...]]
const BLOCKS = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
  6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]],
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const capacity = (v) => BLOCKS[v][1].reduce((s, [n, k]) => s + n * k, 0);

function encodeData(bytes) {
  for (let v = 1; v <= 10; v++) {
    const ccBits = v < 10 ? 8 : 16;
    const cap = capacity(v) * 8;
    if (4 + ccBits + bytes.length * 8 > cap) continue;
    const bits = [];
    const push = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(0b0100, 4);
    push(bytes.length, ccBits);
    bytes.forEach((b) => push(b, 8));
    push(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    const words = [];
    for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    for (let pad = 0xec; words.length < capacity(v); pad ^= 0xec ^ 0x11) words.push(pad);

    // Split into blocks, add error correction, interleave.
    const [ecLen, groups] = BLOCKS[v];
    const blocks = [];
    let k = 0;
    for (const [count, size] of groups)
      for (let b = 0; b < count; b++) {
        const d = words.slice(k, k + size);
        k += size;
        blocks.push({ d, e: ecc(d, ecLen) });
      }
    const out = [];
    const maxD = Math.max(...blocks.map((b) => b.d.length));
    for (let i = 0; i < maxD; i++) blocks.forEach((b) => i < b.d.length && out.push(b.d[i]));
    for (let i = 0; i < ecLen; i++) blocks.forEach((b) => out.push(b.e[i]));
    return { version: v, codewords: out };
  }
  throw new Error("text too long for a QR code up to version 10");
}

// ---- matrix -------------------------------------------------------------------------------

export function qrMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const { version, codewords } = encodeData(bytes);
  const size = 17 + 4 * version;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }   // timing
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const al = ALIGN[version];
  for (let i = 0; i < al.length; i++)
    for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

  const drawFormat = (mask) => {
    const data = (0 << 3) | mask;   // level M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);   // reserve the format areas
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), c = Math.floor(i / 3);
      set(a, c, b);
      set(c, a, b);
    }
  }

  // Data in the zig-zag order.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) {
          m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (k) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[k](x, y)) m[y][x] = !m[y][x];
  };
  const penalty = () => {
    let p = 0;
    for (let y = 0; y < size; y++)   // runs of 5+ in rows and columns
      for (const line of [m[y], m.map((row) => row[y])]) {
        let run = 1;
        for (let x = 1; x <= size; x++) {
          if (x < size && line[x] === line[x - 1]) run++;
          else { if (run >= 5) p += run - 2; run = 1; }
        }
      }
    for (let y = 0; y < size - 1; y++)   // 2x2 blocks
      for (let x = 0; x < size - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    let dark = 0;
    m.forEach((row) => row.forEach((d) => (dark += d)));
    p += Math.floor(Math.abs((dark * 20) / (size * size) - 10)) * 10;   // balance
    return p;
  };
  let best = 0, bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    applyMask(k);
    drawFormat(k);
    const s = penalty();
    if (s < bestScore) { bestScore = s; best = k; }
    applyMask(k);   // undo (XOR)
  }
  applyMask(best);
  drawFormat(best);
  return m;
}

export function qrSvg(text, { quiet = 4, className = "qr" } = {}) {
  const m = qrMatrix(text);
  const n = m.length + quiet * 2;
  let d = "";
  m.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x + quiet},${y + quiet}h1v1h-1z`)));
  return `<svg class="${className}" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
