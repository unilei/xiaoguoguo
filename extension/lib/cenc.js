// CENC 解密的浏览器版：MP4 解析逐行对照 vendor 实现，
// 解密动作用 WebCrypto AES-CTR 异步重写（node:crypto 是同步流式 API）。
//
// 关键约定：
//   - prepareCencHeader / parseTrack / buildSamples / deriveContentKey /
//     decryptSpadeUrl 与 vendor 逻辑一致（字节级对照，见 test/cenc.test.mjs）
//   - decryptRange 对应 vendor 的 decryptPartial，唯一改成 async
import { Buffer } from "./buffer.js";

const subtle = globalThis.crypto?.subtle;

async function aesCtr(keyBytes, iv, data) {
  const cryptoKey = await subtle.importKey("raw", new Uint8Array(keyBytes), "AES-CTR", false, [
    "decrypt",
  ]);
  const out = await subtle.decrypt(
    { name: "AES-CTR", counter: new Uint8Array(iv), length: 64 },
    cryptoKey,
    new Uint8Array(data)
  );
  return Buffer.from(out);
}

async function aesCbcDecrypt(keyBytes, iv, data) {
  const cryptoKey = await subtle.importKey("raw", new Uint8Array(keyBytes), "AES-CBC", false, [
    "decrypt",
  ]);
  const out = await subtle.decrypt(
    { name: "AES-CBC", iv: new Uint8Array(iv) },
    cryptoKey,
    new Uint8Array(data)
  );
  return Buffer.from(out);
}

async function sha512(data) {
  const out = await subtle.digest("SHA-512", new Uint8Array(data));
  return Buffer.from(out);
}

const str = (value) => (value == null ? "" : String(value));

// ---------------------------------------------------------------- spade_a 密钥

/**
 * 从 spade_a 推导 CENC 密钥（16 字节）。
 * 与 vendor 的 deriveContentKey 一致：base64 解码 → 混淆变换 →
 * 取第 1..33 字节的 ascii-hex。
 */
export function deriveContentKeySync(value) {
  const raw = Buffer.from(
    str(value).replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  );
  if (raw.length < 3) throw new Error("spade_a too short");
  let v8 = raw.length - (raw[0] ^ raw[1] ^ raw[2]) + 47;
  v8 = Math.min(v8, raw.length - 1);
  if (v8 < 33) throw new Error("spade_a key length invalid");
  const work = Buffer.from(raw.subarray(1, 1 + v8));
  let a = 85;
  let b = 246;
  for (let i = 0; i < v8; i += 1) {
    const old = work[i];
    const previous = i & 1 ? a : b;
    if (i & 1) a = old;
    else b = old;
    const pop = i.toString(2).split("1").length - 1;
    work[i] = (-21 - pop + (previous ^ old)) & 255;
  }
  return Buffer.from(work.subarray(1, 33).toString("ascii"), "hex");
}

// ---------------------------------------------------------------- spade URL

const SPADE_CONSTANTS = Buffer.from(
  "4dd4c2e6b83162090e52b3c7a67b3ba41cb2462b829ab58a196b39db57177524" +
    "f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58",
  "hex"
);

/**
 * 解 SPADE 包过的播放地址（vendor 的 decryptSpadeUrl 的异步版）。
 */
export async function decryptSpadeUrl(value, seed) {
  const encoded = str(value);
  if (!encoded) return "";
  const raw = Buffer.from(encoded, "base64");
  if (raw.length < 5) throw new Error("spade URL ciphertext too short");
  if (raw[0] !== 0xa8 || raw[2] !== 0x01 || raw[3] !== 0x00)
    throw new Error("spade URL header format error");
  const cipherLength = Math.floor((raw.length - 4) / 16) * 16;
  if (!cipherLength) throw new Error("spade URL ciphertext has no complete block");
  const h1 = await sha512(seed);
  const h2 = await sha512(Buffer.concat([h1, SPADE_CONSTANTS]));
  let plaintext = await aesCbcDecrypt(
    h2.subarray(0, 16),
    h2.subarray(16, 32),
    raw.subarray(4, 4 + cipherLength)
  );
  // WebCrypto 的 AES-CBC 会自动去 PKCS#7 填充；vendor 关了自动填充并手动处理，
  // 这里对已解出的明文补上等价的后处理（去零尾）。
  while (plaintext.length && plaintext[plaintext.length - 1] === 0)
    plaintext = plaintext.subarray(0, plaintext.length - 1);
  return plaintext.toString("utf8");
}

// ---------------------------------------------------------------- MP4 解析

function readBox(data, offset) {
  if (offset < 0 || offset + 8 > data.length) return null;
  let size = data.readUInt32BE(offset);
  const type = data.toString("ascii", offset + 4, offset + 8);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > data.length) return null;
    const large = data.readBigUInt64BE(offset + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    header = 16;
  } else if (size === 0) size = data.length - offset;
  if (size < header || offset + size > data.length) return null;
  return { offset, size, type, header, bodyStart: offset + header };
}

function findBox(data, type, start = 0) {
  for (let offset = Math.max(0, start); offset + 8 <= data.length; offset += 1) {
    const box = readBox(data, offset);
    if (box?.type === type) return box;
  }
  return null;
}

function boxBody(data, type, start = 0) {
  const box = findBox(data, type, start);
  return box ? data.subarray(box.bodyStart, box.offset + box.size) : null;
}

function readU64(data, offset) {
  const value = data.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("MP4 offset too large");
  return Number(value);
}

function parseTrack(moov, track) {
  const stbl = findBox(moov, "stbl", track.bodyStart);
  if (!stbl) return null;
  const stsz = boxBody(moov, "stsz", stbl.bodyStart);
  const stsc = boxBody(moov, "stsc", stbl.bodyStart);
  const chunkBox = findBox(moov, "stco", stbl.bodyStart) || findBox(moov, "co64", stbl.bodyStart);
  const saiz = boxBody(moov, "saiz", stbl.bodyStart);
  const saio = boxBody(moov, "saio", stbl.bodyStart);
  if (
    !stsz || !stsc || !chunkBox || !saiz || !saio ||
    stsz.length < 12 || stsc.length < 8 || saiz.length < 9 || saio.length < 8
  )
    return null;

  const defaultSampleSize = stsz.readUInt32BE(4);
  const sampleCount = stsz.readUInt32BE(8);
  const sizes = [];
  if (defaultSampleSize) sizes.push(...Array(sampleCount).fill(defaultSampleSize));
  else
    for (let i = 0; i < sampleCount && 12 + (i + 1) * 4 <= stsz.length; i += 1)
      sizes.push(stsz.readUInt32BE(12 + i * 4));
  if (sizes.length !== sampleCount) return null;

  const chunkCount =
    chunkBox.bodyStart + 8 <= chunkBox.offset + chunkBox.size
      ? moov.readUInt32BE(chunkBox.bodyStart + 4)
      : 0;
  const offsets = [];
  for (let i = 0; i < chunkCount; i += 1) {
    const at = chunkBox.bodyStart + 8 + i * (chunkBox.type === "co64" ? 8 : 4);
    if (at + (chunkBox.type === "co64" ? 8 : 4) > chunkBox.offset + chunkBox.size) return null;
    offsets.push(chunkBox.type === "co64" ? readU64(moov, at) : moov.readUInt32BE(at));
  }

  const entryCount = stsc.readUInt32BE(4);
  const entries = [];
  for (let i = 0; i < entryCount; i += 1) {
    const at = 8 + i * 12;
    if (at + 8 > stsc.length) return null;
    entries.push({ firstChunk: stsc.readUInt32BE(at), samplesPerChunk: stsc.readUInt32BE(at + 4) });
  }
  const samplesPerChunk = offsets.map((_value, index) => {
    let selected = 0;
    for (const entry of entries) if (entry.firstChunk <= index + 1) selected = entry.samplesPerChunk;
    return selected;
  });

  const auxDefault = saiz[4];
  const auxCount = saiz.readUInt32BE(5);
  const auxSizes = [];
  if (auxDefault) auxSizes.push(...Array(auxCount).fill(auxDefault));
  else for (let i = 0; i < auxCount && 9 + i < saiz.length; i += 1) auxSizes.push(saiz[9 + i]);
  if (auxSizes.length !== auxCount) return null;

  const saioVersion = saio.readUInt32BE(0) >>> 24;
  const offsetSize = saioVersion === 1 ? 8 : 4;
  const saioCount = saio.readUInt32BE(4);
  if (!saioCount || 8 + offsetSize > saio.length) return null;
  const auxOffset = offsetSize === 8 ? readU64(saio, 8) : saio.readUInt32BE(8);
  return { sizes, offsets, samplesPerChunk, auxOffset, auxSizes, sampleCount };
}

function buildSamples(data, tracks) {
  const samples = [];
  for (const track of tracks) {
    let sampleIndex = 0;
    let auxPos = 0;
    const auxTotal = track.auxSizes.reduce((sum, size) => sum + Math.max(size, 8), 0);
    if (track.auxOffset < 0 || track.auxOffset + auxTotal > data.length)
      throw new Error("MP4 auxiliary data out of range");
    const aux = data.subarray(track.auxOffset, track.auxOffset + auxTotal);
    for (let chunk = 0; chunk < track.offsets.length && sampleIndex < track.sampleCount; chunk += 1) {
      let offset = track.offsets[chunk];
      const count = track.samplesPerChunk[chunk] || 0;
      for (let index = 0; index < count && sampleIndex < track.sampleCount; index += 1) {
        const size = track.sizes[sampleIndex];
        const auxSize = Math.max(track.auxSizes[sampleIndex] || 8, 8);
        const iv = Buffer.alloc(16);
        aux.copy(iv, 0, auxPos, auxPos + Math.min(8, auxSize));
        samples.push({ start: offset, end: offset + size, iv });
        offset += size;
        sampleIndex += 1;
        auxPos += auxSize;
      }
    }
  }
  return samples.sort((a, b) => a.start - b.start);
}

function replaceFourcc(data, from, to) {
  let offset = 0;
  const source = Buffer.from(from);
  while ((offset = data.indexOf(source, offset)) >= 0) {
    data.write(to, offset, "ascii");
    offset += source.length;
  }
}

function replaceSinf(data) {
  let offset = 0;
  while ((offset = data.indexOf(Buffer.from("sinf"), offset)) >= 0) {
    if (offset < 4) {
      offset += 4;
      continue;
    }
    const size = data.readUInt32BE(offset - 4);
    const end = offset - 4 + size;
    if (size >= 8 && size < 50000 && end <= data.length) {
      data.write("free", offset, "ascii");
      data.fill(0, offset + 4, end);
      offset = end;
    } else offset += 4;
  }
}

/** 对应 vendor 的 prepareCencHeader（解密动作延后到 decryptRange）。 */
export function prepareCencHeader(data, hasKey) {
  const ftypSize = data.readUInt32BE(0);
  const moov = readBox(data, ftypSize);
  if (!moov || moov.type !== "moov") throw new Error("invalid MP4 moov");
  const moovBody = data.subarray(moov.bodyStart, moov.offset + moov.size);
  const tracks = [];
  let cursor = 0;
  for (;;) {
    const track = findBox(moovBody, "trak", cursor);
    if (!track) break;
    tracks.push(track);
    cursor = track.offset + track.size;
  }
  const parsed = tracks.map((track) => parseTrack(moovBody, track)).filter(Boolean);
  const samples = hasKey ? buildSamples(data, parsed) : [];
  const header = Buffer.from(data.subarray(0, moov.offset + moov.size));
  replaceFourcc(header, "encv", "hvc1");
  replaceFourcc(header, "enca", "mp4a");
  replaceSinf(header);
  return { header, samples };
}

function addCounter(iv, blocks) {
  const value = (iv.readBigUInt64BE(0) << 64n) | iv.readBigUInt64BE(8);
  const next = (value + BigInt(blocks)) & ((1n << 128n) - 1n);
  const result = Buffer.alloc(16);
  result.writeBigUInt64BE(next >> 64n, 0);
  result.writeBigUInt64BE(next & ((1n << 64n) - 1n), 8);
  return result;
}

/**
 * 解密 [start, end) 范围的数据。对应 vendor 的 decryptPartial（async 版）。
 *
 * vendor 用 decipher.update(zerbuffer(skip)) 跳过块内偏移；WebCrypto 没有
 * 流式接口，等价做法是：从 sample 块起始计数器解出 skip+slice 长度，
 * 再切掉前 skip 字节。
 */
export async function decryptRange(data, start, key, prepared) {
  const output = Buffer.from(data);
  const end = start + output.length;
  if (start < prepared.header.length)
    prepared.header.copy(output, 0, start, Math.min(end, prepared.header.length));
  if (!key) return output;

  let index = 0;
  while (index < prepared.samples.length && prepared.samples[index].end <= start) index += 1;
  const jobs = [];
  for (; index < prepared.samples.length; index += 1) {
    const sample = prepared.samples[index];
    if (sample.start >= end) break;
    const overlapStart = Math.max(start, sample.start);
    const overlapEnd = Math.min(end, sample.end);
    if (overlapStart >= overlapEnd) continue;
    const relative = overlapStart - sample.start;
    const block = Math.floor(relative / 16);
    const skip = relative % 16;
    const sliceLength = overlapEnd - overlapStart;
    const iv = addCounter(sample.iv, block);
    const targetStart = overlapStart - start;
    jobs.push({ iv, skip, sliceLength, targetStart });
  }

  // 逐个解（并发会让 WebCrypto 内部排队，串行更省内存峰值）
  for (const job of jobs) {
    const total = Math.ceil((job.skip + job.sliceLength) / 16) * 16;
    const input = Buffer.alloc(total);
    output.copy(input, job.skip, job.targetStart, job.targetStart + job.sliceLength);
    const decrypted = await aesCtr(key, job.iv, input);
    decrypted.copy(output, job.targetStart, job.skip, job.skip + job.sliceLength);
  }
  return output;
}
