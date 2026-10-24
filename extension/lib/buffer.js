// 浏览器版 Buffer polyfill。
//
// 只实现 vendor/设备注册/CENC 解密用到的 API 子集，
// 基于 Uint8Array 子类：下标读写原生支持，也能直接传给 fetch/crypto.subtle。
// 在 Node 里也能跑（测试用），与原生 Buffer 做过字节级对照。
const HEX = "0123456789abcdef";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function utf8ToBytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63)
      );
  }
  return out;
}

function bytesToUtf8(bytes) {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63));
      i += 2;
    } else if (b < 0xf0) {
      out += String.fromCharCode(((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63));
      i += 3;
    } else {
      const cp =
        ((b & 7) << 18) |
        ((bytes[i + 1] & 63) << 12) |
        ((bytes[i + 2] & 63) << 6) |
        (bytes[i + 3] & 63);
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    }
  }
  return out;
}

function hexToBytes(text) {
  // 与原生一致：遇到非法字符立即截断；奇数长度丢弃最后一个半字节
  const out = [];
  for (let i = 0; i + 1 < text.length; i += 2) {
    const hi = HEX.indexOf(text[i]);
    const lo = HEX.indexOf(text[i + 1]);
    if (hi < 0 || lo < 0) break;
    out.push((hi << 4) | lo);
  }
  return new Uint8Array(out);
}

function base64ToBytes(text) {
  const clean = text.replace(/[\s=]+/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let pos = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => {
      const at = B64.indexOf(clean[i + k] ?? "A");
      return at < 0 ? 0 : at;
    });
    const bits = (n[0] << 18) | (n[1] << 12) | (n[2] << 6) | n[3];
    out[pos++] = (bits >> 16) & 255;
    if (i + 2 < clean.length) out[pos++] = (bits >> 8) & 255;
    if (i + 3 < clean.length) out[pos++] = bits & 255;
  }
  return out.subarray(0, pos);
}

function encode(text, encoding) {
  switch (encoding) {
    case "hex":
      return hexToBytes(text);
    case "base64":
      return base64ToBytes(text);
    case "ascii":
    case "latin1": {
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 255;
      return out;
    }
    default:
      return new Uint8Array(utf8ToBytes(text));
  }
}

class BufferShim extends Uint8Array {
  subarray(start, end) {
    const view = super.subarray(start, end);
    Object.setPrototypeOf(view, BufferShim.prototype);
    return view;
  }

  slice(start, end) {
    return this.subarray(start, end);
  }

  readUInt32BE(offset) {
    return (
      ((this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]) >>> 0
    );
  }

  readUInt32LE(offset) {
    return (
      (this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24)) >>> 0
    );
  }

  writeFloatLE(value, offset = 0) {
    new DataView(this.buffer, this.byteOffset + offset).setFloat32(0, Number(value), true);
    return offset + 4;
  }

  writeDoubleLE(value, offset = 0) {
    new DataView(this.buffer, this.byteOffset + offset).setFloat64(0, Number(value), true);
    return offset + 8;
  }

  readUInt16BE(offset) {
    return (this[offset] << 8) | this[offset + 1];
  }

  readBigUInt64LE(offset) {
    let value = 0n;
    for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(this[offset + i]);
    return value;
  }

  readBigUInt64BE(offset) {
    let value = 0n;
    for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(this[offset + i]);
    return value;
  }

  writeUInt32BE(value, offset = 0) {
    const v = value >>> 0;
    this[offset] = v >>> 24;
    this[offset + 1] = (v >>> 16) & 255;
    this[offset + 2] = (v >>> 8) & 255;
    this[offset + 3] = v & 255;
    return offset + 4;
  }

  writeUInt32LE(value, offset = 0) {
    const v = value >>> 0;
    this[offset] = v & 255;
    this[offset + 1] = (v >>> 8) & 255;
    this[offset + 2] = (v >>> 16) & 255;
    this[offset + 3] = v >>> 24;
    return offset + 4;
  }

  writeBigUInt64LE(value, offset = 0) {
    let v = BigInt.asUintN(64, BigInt(value));
    for (let i = 0; i < 8; i += 1) {
      this[offset + i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return offset + 8;
  }

  writeBigUInt64BE(value, offset = 0) {
    let v = BigInt(value);
    for (let i = 7; i >= 0; i -= 1) {
      this[offset + i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return offset + 8;
  }

  write(text, offset = 0, encoding) {
    const bytes = encode(text, encoding);
    for (let i = 0; i < bytes.length; i += 1) this[offset + i] = bytes[i];
    return bytes.length;
  }

  fill(value, start = 0, end = this.length) {
    const v = typeof value === "string" ? encode(value)[0] || 0 : value;
    for (let i = start; i < end; i += 1) this[i] = v;
    return this;
  }

  copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
    for (let i = sourceStart; i < sourceEnd; i += 1) {
      if (targetStart + (i - sourceStart) >= target.length) break;
      target[targetStart + (i - sourceStart)] = this[i];
    }
    return Math.min(sourceEnd - sourceStart, Math.max(0, target.length - targetStart));
  }

  indexOf(needle, start = 0) {
    const n = needle instanceof Uint8Array ? needle : encode(String(needle));
    if (!n.length) return start;
    outer: for (let i = start; i <= this.length - n.length; i += 1) {
      for (let j = 0; j < n.length; j += 1) if (this[i + j] !== n[j]) continue outer;
      return i;
    }
    return -1;
  }

  reverse() {
    super.reverse();
    return this;
  }

  toString(encoding, start = 0, end = this.length) {
    const view = super.subarray(start, end);
    switch (encoding) {
      case "hex": {
        let out = "";
        for (const b of view) out += HEX[b >> 4] + HEX[b & 15];
        return out;
      }
      case "base64": {
        let out = "";
        for (let i = 0; i < view.length; i += 3) {
          const b0 = view[i];
          const b1 = i + 1 < view.length ? view[i + 1] : null;
          const b2 = i + 2 < view.length ? view[i + 2] : null;
          out += B64[b0 >> 2];
          out += B64[((b0 & 3) << 4) | (b1 === null ? 0 : b1 >> 4)];
          out += b1 === null ? "=" : B64[((b1 & 15) << 2) | (b2 === null ? 0 : b2 >> 6)];
          out += b2 === null ? "=" : B64[b2 & 63];
        }
        return out;
      }
      case "ascii":
      case "latin1": {
        let s = "";
        for (const b of view) s += String.fromCharCode(b);
        return s;
      }
      default:
        return bytesToUtf8(view);
    }
  }
}

const Buffer = {
  from(value, encoding) {
    if (value instanceof Uint8Array) {
      const out = new BufferShim(value.length);
      out.set(value);
      return out;
    }
    if (Array.isArray(value)) {
      const out = new BufferShim(value.length);
      out.set(value);
      return out;
    }
    if (value instanceof ArrayBuffer) {
      const out = new BufferShim(value.byteLength);
      out.set(new Uint8Array(value));
      return out;
    }
    if (typeof value === "string") {
      const bytes = encode(value, encoding);
      const out = new BufferShim(bytes.length);
      out.set(bytes);
      return out;
    }
    throw new TypeError("Buffer.from: 不支持的入参");
  },
  alloc(length, fill) {
    const out = new BufferShim(length);
    if (fill !== undefined) out.fill(fill);
    return out;
  },
  allocUnsafe(length) {
    return new BufferShim(length);
  },
  concat(list) {
    let total = 0;
    for (const item of list) total += item.length;
    const out = new BufferShim(total);
    let offset = 0;
    for (const item of list) {
      out.set(item, offset);
      offset += item.length;
    }
    return out;
  },
  isBuffer(value) {
    return value instanceof BufferShim;
  },
  byteLength(text, encoding) {
    return encode(String(text), encoding).length;
  },
};

export { Buffer, BufferShim };
