// 纯 JS 的 SM3（GB/T 32905-2016）。
//
// Cloudflare Workers 的 node:crypto 不支持 sm3（实测 "Digest method not supported"），
// 而签名头 x-medusa / 分支号计算都要用它，所以这里自带一份实现。
// 输出与 Node 原生 crypto.createHash("sm3") 逐字节一致（已对照测试）。
const IV = [
  0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
  0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
];

const rotl = (x, n) => {
  const v = n & 31;
  return ((x << v) | (x >>> (32 - v))) >>> 0;
};

const P0 = (x) => (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0;
const P1 = (x) => (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0;

function compress(state, block) {
  const w = new Array(68);
  for (let i = 0; i < 16; i += 1) w[i] = block.readUInt32BE(i * 4);
  for (let i = 16; i < 68; i += 1)
    w[i] = (P1((w[i - 16] ^ w[i - 9] ^ rotl(w[i - 3], 15)) >>> 0) ^ rotl(w[i - 13], 7) ^ w[i - 6]) >>> 0;

  const w1 = new Array(64);
  for (let i = 0; i < 64; i += 1) w1[i] = (w[i] ^ w[i + 4]) >>> 0;

  let [a, b, c, d, e, f, g, h] = state;
  for (let j = 0; j < 64; j += 1) {
    const t = j < 16 ? 0x79cc4519 : 0x7a879d8a;
    const ss1 = rotl((rotl(a, 12) + e + rotl(t, j)) >>> 0, 7);
    const ss2 = (ss1 ^ rotl(a, 12)) >>> 0;
    const ff = j < 16 ? (a ^ b ^ c) >>> 0 : ((a & b) | (a & c) | (b & c)) >>> 0;
    const gg = j < 16 ? (e ^ f ^ g) >>> 0 : ((e & f) | (~e & g)) >>> 0;
    const tt1 = (ff + d + ss2 + w1[j]) >>> 0;
    const tt2 = (gg + h + ss1 + w[j]) >>> 0;
    d = c;
    c = rotl(b, 9);
    b = a;
    a = tt1;
    h = g;
    g = rotl(f, 19);
    f = e;
    e = P0(tt2);
  }
  state[0] = (state[0] ^ a) >>> 0;
  state[1] = (state[1] ^ b) >>> 0;
  state[2] = (state[2] ^ c) >>> 0;
  state[3] = (state[3] ^ d) >>> 0;
  state[4] = (state[4] ^ e) >>> 0;
  state[5] = (state[5] ^ f) >>> 0;
  state[6] = (state[6] ^ g) >>> 0;
  state[7] = (state[7] ^ h) >>> 0;
}

/** 计算 SM3 摘要，返回 Buffer（32 字节）。 */
export function sm3(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const bitLength = data.length * 8;
  // 填充：0x80 + 若干 0 + 64 位长度（大端）
  const padLength = ((data.length + 9 + 63) & ~63) >>> 0;
  const padded = Buffer.alloc(padLength);
  data.copy(padded);
  padded[data.length] = 0x80;
  padded.writeUInt32BE(Math.floor(bitLength / 0x100000000), padLength - 8);
  padded.writeUInt32BE(bitLength >>> 0, padLength - 4);

  const state = IV.slice();
  for (let offset = 0; offset < padded.length; offset += 64)
    compress(state, padded.subarray(offset, offset + 64));

  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i += 1) out.writeUInt32BE(state[i], i * 4);
  return out;
}
