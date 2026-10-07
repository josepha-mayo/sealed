var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/@noble/hashes/crypto.js
var require_crypto = __commonJS({
  "node_modules/@noble/hashes/crypto.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.crypto = void 0;
    exports.crypto = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : void 0;
  }
});

// node_modules/@noble/hashes/utils.js
var require_utils = __commonJS({
  "node_modules/@noble/hashes/utils.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.wrapXOFConstructorWithOpts = exports.wrapConstructorWithOpts = exports.wrapConstructor = exports.Hash = exports.nextTick = exports.swap32IfBE = exports.byteSwapIfBE = exports.swap8IfBE = exports.isLE = void 0;
    exports.isBytes = isBytes;
    exports.anumber = anumber;
    exports.abytes = abytes;
    exports.ahash = ahash;
    exports.aexists = aexists;
    exports.aoutput = aoutput;
    exports.u8 = u8;
    exports.u32 = u32;
    exports.clean = clean;
    exports.createView = createView;
    exports.rotr = rotr;
    exports.rotl = rotl;
    exports.byteSwap = byteSwap;
    exports.byteSwap32 = byteSwap32;
    exports.bytesToHex = bytesToHex;
    exports.hexToBytes = hexToBytes;
    exports.asyncLoop = asyncLoop;
    exports.utf8ToBytes = utf8ToBytes;
    exports.bytesToUtf8 = bytesToUtf8;
    exports.toBytes = toBytes;
    exports.kdfInputToBytes = kdfInputToBytes;
    exports.concatBytes = concatBytes;
    exports.checkOpts = checkOpts;
    exports.createHasher = createHasher;
    exports.createOptHasher = createOptHasher;
    exports.createXOFer = createXOFer;
    exports.randomBytes = randomBytes;
    var crypto_1 = require_crypto();
    function isBytes(a) {
      return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
    }
    function anumber(n) {
      if (!Number.isSafeInteger(n) || n < 0)
        throw new Error("positive integer expected, got " + n);
    }
    function abytes(b, ...lengths) {
      if (!isBytes(b))
        throw new Error("Uint8Array expected");
      if (lengths.length > 0 && !lengths.includes(b.length))
        throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
    }
    function ahash(h) {
      if (typeof h !== "function" || typeof h.create !== "function")
        throw new Error("Hash should be wrapped by utils.createHasher");
      anumber(h.outputLen);
      anumber(h.blockLen);
    }
    function aexists(instance, checkFinished = true) {
      if (instance.destroyed)
        throw new Error("Hash instance has been destroyed");
      if (checkFinished && instance.finished)
        throw new Error("Hash#digest() has already been called");
    }
    function aoutput(out, instance) {
      abytes(out);
      const min = instance.outputLen;
      if (out.length < min) {
        throw new Error("digestInto() expects output buffer of length at least " + min);
      }
    }
    function u8(arr) {
      return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    }
    function u32(arr) {
      return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
    }
    function clean(...arrays) {
      for (let i = 0; i < arrays.length; i++) {
        arrays[i].fill(0);
      }
    }
    function createView(arr) {
      return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
    }
    function rotr(word, shift) {
      return word << 32 - shift | word >>> shift;
    }
    function rotl(word, shift) {
      return word << shift | word >>> 32 - shift >>> 0;
    }
    exports.isLE = (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
    function byteSwap(word) {
      return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
    }
    exports.swap8IfBE = exports.isLE ? (n) => n : (n) => byteSwap(n);
    exports.byteSwapIfBE = exports.swap8IfBE;
    function byteSwap32(arr) {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = byteSwap(arr[i]);
      }
      return arr;
    }
    exports.swap32IfBE = exports.isLE ? (u) => u : byteSwap32;
    var hasHexBuiltin = /* @__PURE__ */ (() => (
      // @ts-ignore
      typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
    ))();
    var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
    function bytesToHex(bytes) {
      abytes(bytes);
      if (hasHexBuiltin)
        return bytes.toHex();
      let hex = "";
      for (let i = 0; i < bytes.length; i++) {
        hex += hexes[bytes[i]];
      }
      return hex;
    }
    var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
    function asciiToBase16(ch) {
      if (ch >= asciis._0 && ch <= asciis._9)
        return ch - asciis._0;
      if (ch >= asciis.A && ch <= asciis.F)
        return ch - (asciis.A - 10);
      if (ch >= asciis.a && ch <= asciis.f)
        return ch - (asciis.a - 10);
      return;
    }
    function hexToBytes(hex) {
      if (typeof hex !== "string")
        throw new Error("hex string expected, got " + typeof hex);
      if (hasHexBuiltin)
        return Uint8Array.fromHex(hex);
      const hl = hex.length;
      const al = hl / 2;
      if (hl % 2)
        throw new Error("hex string expected, got unpadded hex of length " + hl);
      const array = new Uint8Array(al);
      for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
        const n1 = asciiToBase16(hex.charCodeAt(hi));
        const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
        if (n1 === void 0 || n2 === void 0) {
          const char = hex[hi] + hex[hi + 1];
          throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
        }
        array[ai] = n1 * 16 + n2;
      }
      return array;
    }
    var nextTick = async () => {
    };
    exports.nextTick = nextTick;
    async function asyncLoop(iters, tick, cb) {
      let ts = Date.now();
      for (let i = 0; i < iters; i++) {
        cb(i);
        const diff = Date.now() - ts;
        if (diff >= 0 && diff < tick)
          continue;
        await (0, exports.nextTick)();
        ts += diff;
      }
    }
    function utf8ToBytes(str) {
      if (typeof str !== "string")
        throw new Error("string expected");
      return new Uint8Array(new TextEncoder().encode(str));
    }
    function bytesToUtf8(bytes) {
      return new TextDecoder().decode(bytes);
    }
    function toBytes(data) {
      if (typeof data === "string")
        data = utf8ToBytes(data);
      abytes(data);
      return data;
    }
    function kdfInputToBytes(data) {
      if (typeof data === "string")
        data = utf8ToBytes(data);
      abytes(data);
      return data;
    }
    function concatBytes(...arrays) {
      let sum = 0;
      for (let i = 0; i < arrays.length; i++) {
        const a = arrays[i];
        abytes(a);
        sum += a.length;
      }
      const res = new Uint8Array(sum);
      for (let i = 0, pad = 0; i < arrays.length; i++) {
        const a = arrays[i];
        res.set(a, pad);
        pad += a.length;
      }
      return res;
    }
    function checkOpts(defaults, opts) {
      if (opts !== void 0 && {}.toString.call(opts) !== "[object Object]")
        throw new Error("options should be object or undefined");
      const merged = Object.assign(defaults, opts);
      return merged;
    }
    var Hash = class {
    };
    exports.Hash = Hash;
    function createHasher(hashCons) {
      const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
      const tmp = hashCons();
      hashC.outputLen = tmp.outputLen;
      hashC.blockLen = tmp.blockLen;
      hashC.create = () => hashCons();
      return hashC;
    }
    function createOptHasher(hashCons) {
      const hashC = (msg, opts) => hashCons(opts).update(toBytes(msg)).digest();
      const tmp = hashCons({});
      hashC.outputLen = tmp.outputLen;
      hashC.blockLen = tmp.blockLen;
      hashC.create = (opts) => hashCons(opts);
      return hashC;
    }
    function createXOFer(hashCons) {
      const hashC = (msg, opts) => hashCons(opts).update(toBytes(msg)).digest();
      const tmp = hashCons({});
      hashC.outputLen = tmp.outputLen;
      hashC.blockLen = tmp.blockLen;
      hashC.create = (opts) => hashCons(opts);
      return hashC;
    }
    exports.wrapConstructor = createHasher;
    exports.wrapConstructorWithOpts = createOptHasher;
    exports.wrapXOFConstructorWithOpts = createXOFer;
    function randomBytes(bytesLength = 32) {
      if (crypto_1.crypto && typeof crypto_1.crypto.getRandomValues === "function") {
        return crypto_1.crypto.getRandomValues(new Uint8Array(bytesLength));
      }
      if (crypto_1.crypto && typeof crypto_1.crypto.randomBytes === "function") {
        return Uint8Array.from(crypto_1.crypto.randomBytes(bytesLength));
      }
      throw new Error("crypto.getRandomValues must be defined");
    }
  }
});

// node_modules/@noble/hashes/_md.js
var require_md = __commonJS({
  "node_modules/@noble/hashes/_md.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SHA512_IV = exports.SHA384_IV = exports.SHA224_IV = exports.SHA256_IV = exports.HashMD = void 0;
    exports.setBigUint64 = setBigUint64;
    exports.Chi = Chi;
    exports.Maj = Maj;
    var utils_ts_1 = require_utils();
    function setBigUint64(view, byteOffset, value, isLE) {
      if (typeof view.setBigUint64 === "function")
        return view.setBigUint64(byteOffset, value, isLE);
      const _32n = BigInt(32);
      const _u32_max = BigInt(4294967295);
      const wh = Number(value >> _32n & _u32_max);
      const wl = Number(value & _u32_max);
      const h = isLE ? 4 : 0;
      const l = isLE ? 0 : 4;
      view.setUint32(byteOffset + h, wh, isLE);
      view.setUint32(byteOffset + l, wl, isLE);
    }
    function Chi(a, b, c) {
      return a & b ^ ~a & c;
    }
    function Maj(a, b, c) {
      return a & b ^ a & c ^ b & c;
    }
    var HashMD = class extends utils_ts_1.Hash {
      constructor(blockLen, outputLen, padOffset, isLE) {
        super();
        this.finished = false;
        this.length = 0;
        this.pos = 0;
        this.destroyed = false;
        this.blockLen = blockLen;
        this.outputLen = outputLen;
        this.padOffset = padOffset;
        this.isLE = isLE;
        this.buffer = new Uint8Array(blockLen);
        this.view = (0, utils_ts_1.createView)(this.buffer);
      }
      update(data) {
        (0, utils_ts_1.aexists)(this);
        data = (0, utils_ts_1.toBytes)(data);
        (0, utils_ts_1.abytes)(data);
        const { view, buffer, blockLen } = this;
        const len = data.length;
        for (let pos = 0; pos < len; ) {
          const take = Math.min(blockLen - this.pos, len - pos);
          if (take === blockLen) {
            const dataView = (0, utils_ts_1.createView)(data);
            for (; blockLen <= len - pos; pos += blockLen)
              this.process(dataView, pos);
            continue;
          }
          buffer.set(data.subarray(pos, pos + take), this.pos);
          this.pos += take;
          pos += take;
          if (this.pos === blockLen) {
            this.process(view, 0);
            this.pos = 0;
          }
        }
        this.length += data.length;
        this.roundClean();
        return this;
      }
      digestInto(out) {
        (0, utils_ts_1.aexists)(this);
        (0, utils_ts_1.aoutput)(out, this);
        this.finished = true;
        const { buffer, view, blockLen, isLE } = this;
        let { pos } = this;
        buffer[pos++] = 128;
        (0, utils_ts_1.clean)(this.buffer.subarray(pos));
        if (this.padOffset > blockLen - pos) {
          this.process(view, 0);
          pos = 0;
        }
        for (let i = pos; i < blockLen; i++)
          buffer[i] = 0;
        setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
        this.process(view, 0);
        const oview = (0, utils_ts_1.createView)(out);
        const len = this.outputLen;
        if (len % 4)
          throw new Error("_sha2: outputLen should be aligned to 32bit");
        const outLen = len / 4;
        const state = this.get();
        if (outLen > state.length)
          throw new Error("_sha2: outputLen bigger than state");
        for (let i = 0; i < outLen; i++)
          oview.setUint32(4 * i, state[i], isLE);
      }
      digest() {
        const { buffer, outputLen } = this;
        this.digestInto(buffer);
        const res = buffer.slice(0, outputLen);
        this.destroy();
        return res;
      }
      _cloneInto(to) {
        to || (to = new this.constructor());
        to.set(...this.get());
        const { blockLen, buffer, length, finished, destroyed, pos } = this;
        to.destroyed = destroyed;
        to.finished = finished;
        to.length = length;
        to.pos = pos;
        if (length % blockLen)
          to.buffer.set(buffer);
        return to;
      }
      clone() {
        return this._cloneInto();
      }
    };
    exports.HashMD = HashMD;
    exports.SHA256_IV = Uint32Array.from([
      1779033703,
      3144134277,
      1013904242,
      2773480762,
      1359893119,
      2600822924,
      528734635,
      1541459225
    ]);
    exports.SHA224_IV = Uint32Array.from([
      3238371032,
      914150663,
      812702999,
      4144912697,
      4290775857,
      1750603025,
      1694076839,
      3204075428
    ]);
    exports.SHA384_IV = Uint32Array.from([
      3418070365,
      3238371032,
      1654270250,
      914150663,
      2438529370,
      812702999,
      355462360,
      4144912697,
      1731405415,
      4290775857,
      2394180231,
      1750603025,
      3675008525,
      1694076839,
      1203062813,
      3204075428
    ]);
    exports.SHA512_IV = Uint32Array.from([
      1779033703,
      4089235720,
      3144134277,
      2227873595,
      1013904242,
      4271175723,
      2773480762,
      1595750129,
      1359893119,
      2917565137,
      2600822924,
      725511199,
      528734635,
      4215389547,
      1541459225,
      327033209
    ]);
  }
});

// node_modules/@noble/hashes/_u64.js
var require_u64 = __commonJS({
  "node_modules/@noble/hashes/_u64.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.toBig = exports.shrSL = exports.shrSH = exports.rotrSL = exports.rotrSH = exports.rotrBL = exports.rotrBH = exports.rotr32L = exports.rotr32H = exports.rotlSL = exports.rotlSH = exports.rotlBL = exports.rotlBH = exports.add5L = exports.add5H = exports.add4L = exports.add4H = exports.add3L = exports.add3H = void 0;
    exports.add = add;
    exports.fromBig = fromBig;
    exports.split = split;
    var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
    var _32n = /* @__PURE__ */ BigInt(32);
    function fromBig(n, le = false) {
      if (le)
        return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
      return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
    }
    function split(lst, le = false) {
      const len = lst.length;
      let Ah = new Uint32Array(len);
      let Al = new Uint32Array(len);
      for (let i = 0; i < len; i++) {
        const { h, l } = fromBig(lst[i], le);
        [Ah[i], Al[i]] = [h, l];
      }
      return [Ah, Al];
    }
    var toBig = (h, l) => BigInt(h >>> 0) << _32n | BigInt(l >>> 0);
    exports.toBig = toBig;
    var shrSH = (h, _l, s) => h >>> s;
    exports.shrSH = shrSH;
    var shrSL = (h, l, s) => h << 32 - s | l >>> s;
    exports.shrSL = shrSL;
    var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
    exports.rotrSH = rotrSH;
    var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
    exports.rotrSL = rotrSL;
    var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
    exports.rotrBH = rotrBH;
    var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
    exports.rotrBL = rotrBL;
    var rotr32H = (_h, l) => l;
    exports.rotr32H = rotr32H;
    var rotr32L = (h, _l) => h;
    exports.rotr32L = rotr32L;
    var rotlSH = (h, l, s) => h << s | l >>> 32 - s;
    exports.rotlSH = rotlSH;
    var rotlSL = (h, l, s) => l << s | h >>> 32 - s;
    exports.rotlSL = rotlSL;
    var rotlBH = (h, l, s) => l << s - 32 | h >>> 64 - s;
    exports.rotlBH = rotlBH;
    var rotlBL = (h, l, s) => h << s - 32 | l >>> 64 - s;
    exports.rotlBL = rotlBL;
    function add(Ah, Al, Bh, Bl) {
      const l = (Al >>> 0) + (Bl >>> 0);
      return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
    }
    var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
    exports.add3L = add3L;
    var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
    exports.add3H = add3H;
    var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
    exports.add4L = add4L;
    var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
    exports.add4H = add4H;
    var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
    exports.add5L = add5L;
    var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;
    exports.add5H = add5H;
    var u64 = {
      fromBig,
      split,
      toBig,
      shrSH,
      shrSL,
      rotrSH,
      rotrSL,
      rotrBH,
      rotrBL,
      rotr32H,
      rotr32L,
      rotlSH,
      rotlSL,
      rotlBH,
      rotlBL,
      add,
      add3L,
      add3H,
      add4L,
      add4H,
      add5H,
      add5L
    };
    exports.default = u64;
  }
});

// node_modules/@noble/hashes/sha2.js
var require_sha2 = __commonJS({
  "node_modules/@noble/hashes/sha2.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.sha512_224 = exports.sha512_256 = exports.sha384 = exports.sha512 = exports.sha224 = exports.sha256 = exports.SHA512_256 = exports.SHA512_224 = exports.SHA384 = exports.SHA512 = exports.SHA224 = exports.SHA256 = void 0;
    var _md_ts_1 = require_md();
    var u64 = require_u64();
    var utils_ts_1 = require_utils();
    var SHA256_K = /* @__PURE__ */ Uint32Array.from([
      1116352408,
      1899447441,
      3049323471,
      3921009573,
      961987163,
      1508970993,
      2453635748,
      2870763221,
      3624381080,
      310598401,
      607225278,
      1426881987,
      1925078388,
      2162078206,
      2614888103,
      3248222580,
      3835390401,
      4022224774,
      264347078,
      604807628,
      770255983,
      1249150122,
      1555081692,
      1996064986,
      2554220882,
      2821834349,
      2952996808,
      3210313671,
      3336571891,
      3584528711,
      113926993,
      338241895,
      666307205,
      773529912,
      1294757372,
      1396182291,
      1695183700,
      1986661051,
      2177026350,
      2456956037,
      2730485921,
      2820302411,
      3259730800,
      3345764771,
      3516065817,
      3600352804,
      4094571909,
      275423344,
      430227734,
      506948616,
      659060556,
      883997877,
      958139571,
      1322822218,
      1537002063,
      1747873779,
      1955562222,
      2024104815,
      2227730452,
      2361852424,
      2428436474,
      2756734187,
      3204031479,
      3329325298
    ]);
    var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
    var SHA256 = class extends _md_ts_1.HashMD {
      constructor(outputLen = 32) {
        super(64, outputLen, 8, false);
        this.A = _md_ts_1.SHA256_IV[0] | 0;
        this.B = _md_ts_1.SHA256_IV[1] | 0;
        this.C = _md_ts_1.SHA256_IV[2] | 0;
        this.D = _md_ts_1.SHA256_IV[3] | 0;
        this.E = _md_ts_1.SHA256_IV[4] | 0;
        this.F = _md_ts_1.SHA256_IV[5] | 0;
        this.G = _md_ts_1.SHA256_IV[6] | 0;
        this.H = _md_ts_1.SHA256_IV[7] | 0;
      }
      get() {
        const { A, B, C, D, E, F, G, H } = this;
        return [A, B, C, D, E, F, G, H];
      }
      // prettier-ignore
      set(A, B, C, D, E, F, G, H) {
        this.A = A | 0;
        this.B = B | 0;
        this.C = C | 0;
        this.D = D | 0;
        this.E = E | 0;
        this.F = F | 0;
        this.G = G | 0;
        this.H = H | 0;
      }
      process(view, offset) {
        for (let i = 0; i < 16; i++, offset += 4)
          SHA256_W[i] = view.getUint32(offset, false);
        for (let i = 16; i < 64; i++) {
          const W15 = SHA256_W[i - 15];
          const W2 = SHA256_W[i - 2];
          const s0 = (0, utils_ts_1.rotr)(W15, 7) ^ (0, utils_ts_1.rotr)(W15, 18) ^ W15 >>> 3;
          const s1 = (0, utils_ts_1.rotr)(W2, 17) ^ (0, utils_ts_1.rotr)(W2, 19) ^ W2 >>> 10;
          SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
        }
        let { A, B, C, D, E, F, G, H } = this;
        for (let i = 0; i < 64; i++) {
          const sigma1 = (0, utils_ts_1.rotr)(E, 6) ^ (0, utils_ts_1.rotr)(E, 11) ^ (0, utils_ts_1.rotr)(E, 25);
          const T1 = H + sigma1 + (0, _md_ts_1.Chi)(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
          const sigma0 = (0, utils_ts_1.rotr)(A, 2) ^ (0, utils_ts_1.rotr)(A, 13) ^ (0, utils_ts_1.rotr)(A, 22);
          const T2 = sigma0 + (0, _md_ts_1.Maj)(A, B, C) | 0;
          H = G;
          G = F;
          F = E;
          E = D + T1 | 0;
          D = C;
          C = B;
          B = A;
          A = T1 + T2 | 0;
        }
        A = A + this.A | 0;
        B = B + this.B | 0;
        C = C + this.C | 0;
        D = D + this.D | 0;
        E = E + this.E | 0;
        F = F + this.F | 0;
        G = G + this.G | 0;
        H = H + this.H | 0;
        this.set(A, B, C, D, E, F, G, H);
      }
      roundClean() {
        (0, utils_ts_1.clean)(SHA256_W);
      }
      destroy() {
        this.set(0, 0, 0, 0, 0, 0, 0, 0);
        (0, utils_ts_1.clean)(this.buffer);
      }
    };
    exports.SHA256 = SHA256;
    var SHA224 = class extends SHA256 {
      constructor() {
        super(28);
        this.A = _md_ts_1.SHA224_IV[0] | 0;
        this.B = _md_ts_1.SHA224_IV[1] | 0;
        this.C = _md_ts_1.SHA224_IV[2] | 0;
        this.D = _md_ts_1.SHA224_IV[3] | 0;
        this.E = _md_ts_1.SHA224_IV[4] | 0;
        this.F = _md_ts_1.SHA224_IV[5] | 0;
        this.G = _md_ts_1.SHA224_IV[6] | 0;
        this.H = _md_ts_1.SHA224_IV[7] | 0;
      }
    };
    exports.SHA224 = SHA224;
    var K512 = /* @__PURE__ */ (() => u64.split([
      "0x428a2f98d728ae22",
      "0x7137449123ef65cd",
      "0xb5c0fbcfec4d3b2f",
      "0xe9b5dba58189dbbc",
      "0x3956c25bf348b538",
      "0x59f111f1b605d019",
      "0x923f82a4af194f9b",
      "0xab1c5ed5da6d8118",
      "0xd807aa98a3030242",
      "0x12835b0145706fbe",
      "0x243185be4ee4b28c",
      "0x550c7dc3d5ffb4e2",
      "0x72be5d74f27b896f",
      "0x80deb1fe3b1696b1",
      "0x9bdc06a725c71235",
      "0xc19bf174cf692694",
      "0xe49b69c19ef14ad2",
      "0xefbe4786384f25e3",
      "0x0fc19dc68b8cd5b5",
      "0x240ca1cc77ac9c65",
      "0x2de92c6f592b0275",
      "0x4a7484aa6ea6e483",
      "0x5cb0a9dcbd41fbd4",
      "0x76f988da831153b5",
      "0x983e5152ee66dfab",
      "0xa831c66d2db43210",
      "0xb00327c898fb213f",
      "0xbf597fc7beef0ee4",
      "0xc6e00bf33da88fc2",
      "0xd5a79147930aa725",
      "0x06ca6351e003826f",
      "0x142929670a0e6e70",
      "0x27b70a8546d22ffc",
      "0x2e1b21385c26c926",
      "0x4d2c6dfc5ac42aed",
      "0x53380d139d95b3df",
      "0x650a73548baf63de",
      "0x766a0abb3c77b2a8",
      "0x81c2c92e47edaee6",
      "0x92722c851482353b",
      "0xa2bfe8a14cf10364",
      "0xa81a664bbc423001",
      "0xc24b8b70d0f89791",
      "0xc76c51a30654be30",
      "0xd192e819d6ef5218",
      "0xd69906245565a910",
      "0xf40e35855771202a",
      "0x106aa07032bbd1b8",
      "0x19a4c116b8d2d0c8",
      "0x1e376c085141ab53",
      "0x2748774cdf8eeb99",
      "0x34b0bcb5e19b48a8",
      "0x391c0cb3c5c95a63",
      "0x4ed8aa4ae3418acb",
      "0x5b9cca4f7763e373",
      "0x682e6ff3d6b2b8a3",
      "0x748f82ee5defb2fc",
      "0x78a5636f43172f60",
      "0x84c87814a1f0ab72",
      "0x8cc702081a6439ec",
      "0x90befffa23631e28",
      "0xa4506cebde82bde9",
      "0xbef9a3f7b2c67915",
      "0xc67178f2e372532b",
      "0xca273eceea26619c",
      "0xd186b8c721c0c207",
      "0xeada7dd6cde0eb1e",
      "0xf57d4f7fee6ed178",
      "0x06f067aa72176fba",
      "0x0a637dc5a2c898a6",
      "0x113f9804bef90dae",
      "0x1b710b35131c471b",
      "0x28db77f523047d84",
      "0x32caab7b40c72493",
      "0x3c9ebe0a15c9bebc",
      "0x431d67c49c100d4c",
      "0x4cc5d4becb3e42b6",
      "0x597f299cfc657e2a",
      "0x5fcb6fab3ad6faec",
      "0x6c44198c4a475817"
    ].map((n) => BigInt(n))))();
    var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
    var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
    var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
    var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
    var SHA512 = class extends _md_ts_1.HashMD {
      constructor(outputLen = 64) {
        super(128, outputLen, 16, false);
        this.Ah = _md_ts_1.SHA512_IV[0] | 0;
        this.Al = _md_ts_1.SHA512_IV[1] | 0;
        this.Bh = _md_ts_1.SHA512_IV[2] | 0;
        this.Bl = _md_ts_1.SHA512_IV[3] | 0;
        this.Ch = _md_ts_1.SHA512_IV[4] | 0;
        this.Cl = _md_ts_1.SHA512_IV[5] | 0;
        this.Dh = _md_ts_1.SHA512_IV[6] | 0;
        this.Dl = _md_ts_1.SHA512_IV[7] | 0;
        this.Eh = _md_ts_1.SHA512_IV[8] | 0;
        this.El = _md_ts_1.SHA512_IV[9] | 0;
        this.Fh = _md_ts_1.SHA512_IV[10] | 0;
        this.Fl = _md_ts_1.SHA512_IV[11] | 0;
        this.Gh = _md_ts_1.SHA512_IV[12] | 0;
        this.Gl = _md_ts_1.SHA512_IV[13] | 0;
        this.Hh = _md_ts_1.SHA512_IV[14] | 0;
        this.Hl = _md_ts_1.SHA512_IV[15] | 0;
      }
      // prettier-ignore
      get() {
        const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
        return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
      }
      // prettier-ignore
      set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
        this.Ah = Ah | 0;
        this.Al = Al | 0;
        this.Bh = Bh | 0;
        this.Bl = Bl | 0;
        this.Ch = Ch | 0;
        this.Cl = Cl | 0;
        this.Dh = Dh | 0;
        this.Dl = Dl | 0;
        this.Eh = Eh | 0;
        this.El = El | 0;
        this.Fh = Fh | 0;
        this.Fl = Fl | 0;
        this.Gh = Gh | 0;
        this.Gl = Gl | 0;
        this.Hh = Hh | 0;
        this.Hl = Hl | 0;
      }
      process(view, offset) {
        for (let i = 0; i < 16; i++, offset += 4) {
          SHA512_W_H[i] = view.getUint32(offset);
          SHA512_W_L[i] = view.getUint32(offset += 4);
        }
        for (let i = 16; i < 80; i++) {
          const W15h = SHA512_W_H[i - 15] | 0;
          const W15l = SHA512_W_L[i - 15] | 0;
          const s0h = u64.rotrSH(W15h, W15l, 1) ^ u64.rotrSH(W15h, W15l, 8) ^ u64.shrSH(W15h, W15l, 7);
          const s0l = u64.rotrSL(W15h, W15l, 1) ^ u64.rotrSL(W15h, W15l, 8) ^ u64.shrSL(W15h, W15l, 7);
          const W2h = SHA512_W_H[i - 2] | 0;
          const W2l = SHA512_W_L[i - 2] | 0;
          const s1h = u64.rotrSH(W2h, W2l, 19) ^ u64.rotrBH(W2h, W2l, 61) ^ u64.shrSH(W2h, W2l, 6);
          const s1l = u64.rotrSL(W2h, W2l, 19) ^ u64.rotrBL(W2h, W2l, 61) ^ u64.shrSL(W2h, W2l, 6);
          const SUMl = u64.add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
          const SUMh = u64.add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
          SHA512_W_H[i] = SUMh | 0;
          SHA512_W_L[i] = SUMl | 0;
        }
        let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
        for (let i = 0; i < 80; i++) {
          const sigma1h = u64.rotrSH(Eh, El, 14) ^ u64.rotrSH(Eh, El, 18) ^ u64.rotrBH(Eh, El, 41);
          const sigma1l = u64.rotrSL(Eh, El, 14) ^ u64.rotrSL(Eh, El, 18) ^ u64.rotrBL(Eh, El, 41);
          const CHIh = Eh & Fh ^ ~Eh & Gh;
          const CHIl = El & Fl ^ ~El & Gl;
          const T1ll = u64.add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
          const T1h = u64.add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
          const T1l = T1ll | 0;
          const sigma0h = u64.rotrSH(Ah, Al, 28) ^ u64.rotrBH(Ah, Al, 34) ^ u64.rotrBH(Ah, Al, 39);
          const sigma0l = u64.rotrSL(Ah, Al, 28) ^ u64.rotrBL(Ah, Al, 34) ^ u64.rotrBL(Ah, Al, 39);
          const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
          const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
          Hh = Gh | 0;
          Hl = Gl | 0;
          Gh = Fh | 0;
          Gl = Fl | 0;
          Fh = Eh | 0;
          Fl = El | 0;
          ({ h: Eh, l: El } = u64.add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
          Dh = Ch | 0;
          Dl = Cl | 0;
          Ch = Bh | 0;
          Cl = Bl | 0;
          Bh = Ah | 0;
          Bl = Al | 0;
          const All = u64.add3L(T1l, sigma0l, MAJl);
          Ah = u64.add3H(All, T1h, sigma0h, MAJh);
          Al = All | 0;
        }
        ({ h: Ah, l: Al } = u64.add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
        ({ h: Bh, l: Bl } = u64.add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
        ({ h: Ch, l: Cl } = u64.add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
        ({ h: Dh, l: Dl } = u64.add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
        ({ h: Eh, l: El } = u64.add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
        ({ h: Fh, l: Fl } = u64.add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
        ({ h: Gh, l: Gl } = u64.add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
        ({ h: Hh, l: Hl } = u64.add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
        this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
      }
      roundClean() {
        (0, utils_ts_1.clean)(SHA512_W_H, SHA512_W_L);
      }
      destroy() {
        (0, utils_ts_1.clean)(this.buffer);
        this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      }
    };
    exports.SHA512 = SHA512;
    var SHA384 = class extends SHA512 {
      constructor() {
        super(48);
        this.Ah = _md_ts_1.SHA384_IV[0] | 0;
        this.Al = _md_ts_1.SHA384_IV[1] | 0;
        this.Bh = _md_ts_1.SHA384_IV[2] | 0;
        this.Bl = _md_ts_1.SHA384_IV[3] | 0;
        this.Ch = _md_ts_1.SHA384_IV[4] | 0;
        this.Cl = _md_ts_1.SHA384_IV[5] | 0;
        this.Dh = _md_ts_1.SHA384_IV[6] | 0;
        this.Dl = _md_ts_1.SHA384_IV[7] | 0;
        this.Eh = _md_ts_1.SHA384_IV[8] | 0;
        this.El = _md_ts_1.SHA384_IV[9] | 0;
        this.Fh = _md_ts_1.SHA384_IV[10] | 0;
        this.Fl = _md_ts_1.SHA384_IV[11] | 0;
        this.Gh = _md_ts_1.SHA384_IV[12] | 0;
        this.Gl = _md_ts_1.SHA384_IV[13] | 0;
        this.Hh = _md_ts_1.SHA384_IV[14] | 0;
        this.Hl = _md_ts_1.SHA384_IV[15] | 0;
      }
    };
    exports.SHA384 = SHA384;
    var T224_IV = /* @__PURE__ */ Uint32Array.from([
      2352822216,
      424955298,
      1944164710,
      2312950998,
      502970286,
      855612546,
      1738396948,
      1479516111,
      258812777,
      2077511080,
      2011393907,
      79989058,
      1067287976,
      1780299464,
      286451373,
      2446758561
    ]);
    var T256_IV = /* @__PURE__ */ Uint32Array.from([
      573645204,
      4230739756,
      2673172387,
      3360449730,
      596883563,
      1867755857,
      2520282905,
      1497426621,
      2519219938,
      2827943907,
      3193839141,
      1401305490,
      721525244,
      746961066,
      246885852,
      2177182882
    ]);
    var SHA512_224 = class extends SHA512 {
      constructor() {
        super(28);
        this.Ah = T224_IV[0] | 0;
        this.Al = T224_IV[1] | 0;
        this.Bh = T224_IV[2] | 0;
        this.Bl = T224_IV[3] | 0;
        this.Ch = T224_IV[4] | 0;
        this.Cl = T224_IV[5] | 0;
        this.Dh = T224_IV[6] | 0;
        this.Dl = T224_IV[7] | 0;
        this.Eh = T224_IV[8] | 0;
        this.El = T224_IV[9] | 0;
        this.Fh = T224_IV[10] | 0;
        this.Fl = T224_IV[11] | 0;
        this.Gh = T224_IV[12] | 0;
        this.Gl = T224_IV[13] | 0;
        this.Hh = T224_IV[14] | 0;
        this.Hl = T224_IV[15] | 0;
      }
    };
    exports.SHA512_224 = SHA512_224;
    var SHA512_256 = class extends SHA512 {
      constructor() {
        super(32);
        this.Ah = T256_IV[0] | 0;
        this.Al = T256_IV[1] | 0;
        this.Bh = T256_IV[2] | 0;
        this.Bl = T256_IV[3] | 0;
        this.Ch = T256_IV[4] | 0;
        this.Cl = T256_IV[5] | 0;
        this.Dh = T256_IV[6] | 0;
        this.Dl = T256_IV[7] | 0;
        this.Eh = T256_IV[8] | 0;
        this.El = T256_IV[9] | 0;
        this.Fh = T256_IV[10] | 0;
        this.Fl = T256_IV[11] | 0;
        this.Gh = T256_IV[12] | 0;
        this.Gl = T256_IV[13] | 0;
        this.Hh = T256_IV[14] | 0;
        this.Hl = T256_IV[15] | 0;
      }
    };
    exports.SHA512_256 = SHA512_256;
    exports.sha256 = (0, utils_ts_1.createHasher)(() => new SHA256());
    exports.sha224 = (0, utils_ts_1.createHasher)(() => new SHA224());
    exports.sha512 = (0, utils_ts_1.createHasher)(() => new SHA512());
    exports.sha384 = (0, utils_ts_1.createHasher)(() => new SHA384());
    exports.sha512_256 = (0, utils_ts_1.createHasher)(() => new SHA512_256());
    exports.sha512_224 = (0, utils_ts_1.createHasher)(() => new SHA512_224());
  }
});

// node_modules/@noble/curves/utils.js
var require_utils2 = __commonJS({
  "node_modules/@noble/curves/utils.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.notImplemented = exports.bitMask = exports.utf8ToBytes = exports.randomBytes = exports.isBytes = exports.hexToBytes = exports.concatBytes = exports.bytesToUtf8 = exports.bytesToHex = exports.anumber = exports.abytes = void 0;
    exports.abool = abool;
    exports._abool2 = _abool2;
    exports._abytes2 = _abytes2;
    exports.numberToHexUnpadded = numberToHexUnpadded;
    exports.hexToNumber = hexToNumber;
    exports.bytesToNumberBE = bytesToNumberBE;
    exports.bytesToNumberLE = bytesToNumberLE;
    exports.numberToBytesBE = numberToBytesBE;
    exports.numberToBytesLE = numberToBytesLE;
    exports.numberToVarBytesBE = numberToVarBytesBE;
    exports.ensureBytes = ensureBytes;
    exports.equalBytes = equalBytes;
    exports.copyBytes = copyBytes;
    exports.asciiToBytes = asciiToBytes;
    exports.inRange = inRange;
    exports.aInRange = aInRange;
    exports.bitLen = bitLen;
    exports.bitGet = bitGet;
    exports.bitSet = bitSet;
    exports.createHmacDrbg = createHmacDrbg;
    exports.validateObject = validateObject;
    exports.isHash = isHash;
    exports._validateObject = _validateObject;
    exports.memoized = memoized;
    var utils_js_1 = require_utils();
    var utils_js_2 = require_utils();
    Object.defineProperty(exports, "abytes", { enumerable: true, get: function() {
      return utils_js_2.abytes;
    } });
    Object.defineProperty(exports, "anumber", { enumerable: true, get: function() {
      return utils_js_2.anumber;
    } });
    Object.defineProperty(exports, "bytesToHex", { enumerable: true, get: function() {
      return utils_js_2.bytesToHex;
    } });
    Object.defineProperty(exports, "bytesToUtf8", { enumerable: true, get: function() {
      return utils_js_2.bytesToUtf8;
    } });
    Object.defineProperty(exports, "concatBytes", { enumerable: true, get: function() {
      return utils_js_2.concatBytes;
    } });
    Object.defineProperty(exports, "hexToBytes", { enumerable: true, get: function() {
      return utils_js_2.hexToBytes;
    } });
    Object.defineProperty(exports, "isBytes", { enumerable: true, get: function() {
      return utils_js_2.isBytes;
    } });
    Object.defineProperty(exports, "randomBytes", { enumerable: true, get: function() {
      return utils_js_2.randomBytes;
    } });
    Object.defineProperty(exports, "utf8ToBytes", { enumerable: true, get: function() {
      return utils_js_2.utf8ToBytes;
    } });
    var _0n = /* @__PURE__ */ BigInt(0);
    var _1n = /* @__PURE__ */ BigInt(1);
    function abool(title, value) {
      if (typeof value !== "boolean")
        throw new Error(title + " boolean expected, got " + value);
    }
    function _abool2(value, title = "") {
      if (typeof value !== "boolean") {
        const prefix = title && `"${title}"`;
        throw new Error(prefix + "expected boolean, got type=" + typeof value);
      }
      return value;
    }
    function _abytes2(value, length, title = "") {
      const bytes = (0, utils_js_1.isBytes)(value);
      const len = value?.length;
      const needsLen = length !== void 0;
      if (!bytes || needsLen && len !== length) {
        const prefix = title && `"${title}" `;
        const ofLen = needsLen ? ` of length ${length}` : "";
        const got = bytes ? `length=${len}` : `type=${typeof value}`;
        throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
      }
      return value;
    }
    function numberToHexUnpadded(num) {
      const hex = num.toString(16);
      return hex.length & 1 ? "0" + hex : hex;
    }
    function hexToNumber(hex) {
      if (typeof hex !== "string")
        throw new Error("hex string expected, got " + typeof hex);
      return hex === "" ? _0n : BigInt("0x" + hex);
    }
    function bytesToNumberBE(bytes) {
      return hexToNumber((0, utils_js_1.bytesToHex)(bytes));
    }
    function bytesToNumberLE(bytes) {
      (0, utils_js_1.abytes)(bytes);
      return hexToNumber((0, utils_js_1.bytesToHex)(Uint8Array.from(bytes).reverse()));
    }
    function numberToBytesBE(n, len) {
      return (0, utils_js_1.hexToBytes)(n.toString(16).padStart(len * 2, "0"));
    }
    function numberToBytesLE(n, len) {
      return numberToBytesBE(n, len).reverse();
    }
    function numberToVarBytesBE(n) {
      return (0, utils_js_1.hexToBytes)(numberToHexUnpadded(n));
    }
    function ensureBytes(title, hex, expectedLength) {
      let res;
      if (typeof hex === "string") {
        try {
          res = (0, utils_js_1.hexToBytes)(hex);
        } catch (e) {
          throw new Error(title + " must be hex string or Uint8Array, cause: " + e);
        }
      } else if ((0, utils_js_1.isBytes)(hex)) {
        res = Uint8Array.from(hex);
      } else {
        throw new Error(title + " must be hex string or Uint8Array");
      }
      const len = res.length;
      if (typeof expectedLength === "number" && len !== expectedLength)
        throw new Error(title + " of length " + expectedLength + " expected, got " + len);
      return res;
    }
    function equalBytes(a, b) {
      if (a.length !== b.length)
        return false;
      let diff = 0;
      for (let i = 0; i < a.length; i++)
        diff |= a[i] ^ b[i];
      return diff === 0;
    }
    function copyBytes(bytes) {
      return Uint8Array.from(bytes);
    }
    function asciiToBytes(ascii) {
      return Uint8Array.from(ascii, (c, i) => {
        const charCode = c.charCodeAt(0);
        if (c.length !== 1 || charCode > 127) {
          throw new Error(`string contains non-ASCII character "${ascii[i]}" with code ${charCode} at position ${i}`);
        }
        return charCode;
      });
    }
    var isPosBig = (n) => typeof n === "bigint" && _0n <= n;
    function inRange(n, min, max) {
      return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
    }
    function aInRange(title, n, min, max) {
      if (!inRange(n, min, max))
        throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
    }
    function bitLen(n) {
      let len;
      for (len = 0; n > _0n; n >>= _1n, len += 1)
        ;
      return len;
    }
    function bitGet(n, pos) {
      return n >> BigInt(pos) & _1n;
    }
    function bitSet(n, pos, value) {
      return n | (value ? _1n : _0n) << BigInt(pos);
    }
    var bitMask = (n) => (_1n << BigInt(n)) - _1n;
    exports.bitMask = bitMask;
    function createHmacDrbg(hashLen, qByteLen, hmacFn) {
      if (typeof hashLen !== "number" || hashLen < 2)
        throw new Error("hashLen must be a number");
      if (typeof qByteLen !== "number" || qByteLen < 2)
        throw new Error("qByteLen must be a number");
      if (typeof hmacFn !== "function")
        throw new Error("hmacFn must be a function");
      const u8n = (len) => new Uint8Array(len);
      const u8of = (byte) => Uint8Array.of(byte);
      let v = u8n(hashLen);
      let k = u8n(hashLen);
      let i = 0;
      const reset = () => {
        v.fill(1);
        k.fill(0);
        i = 0;
      };
      const h = (...b) => hmacFn(k, v, ...b);
      const reseed = (seed = u8n(0)) => {
        k = h(u8of(0), seed);
        v = h();
        if (seed.length === 0)
          return;
        k = h(u8of(1), seed);
        v = h();
      };
      const gen = () => {
        if (i++ >= 1e3)
          throw new Error("drbg: tried 1000 values");
        let len = 0;
        const out = [];
        while (len < qByteLen) {
          v = h();
          const sl = v.slice();
          out.push(sl);
          len += v.length;
        }
        return (0, utils_js_1.concatBytes)(...out);
      };
      const genUntil = (seed, pred) => {
        reset();
        reseed(seed);
        let res = void 0;
        while (!(res = pred(gen())))
          reseed();
        reset();
        return res;
      };
      return genUntil;
    }
    var validatorFns = {
      bigint: (val) => typeof val === "bigint",
      function: (val) => typeof val === "function",
      boolean: (val) => typeof val === "boolean",
      string: (val) => typeof val === "string",
      stringOrUint8Array: (val) => typeof val === "string" || (0, utils_js_1.isBytes)(val),
      isSafeInteger: (val) => Number.isSafeInteger(val),
      array: (val) => Array.isArray(val),
      field: (val, object) => object.Fp.isValid(val),
      hash: (val) => typeof val === "function" && Number.isSafeInteger(val.outputLen)
    };
    function validateObject(object, validators, optValidators = {}) {
      const checkField = (fieldName, type, isOptional) => {
        const checkVal = validatorFns[type];
        if (typeof checkVal !== "function")
          throw new Error("invalid validator function");
        const val = object[fieldName];
        if (isOptional && val === void 0)
          return;
        if (!checkVal(val, object)) {
          throw new Error("param " + String(fieldName) + " is invalid. Expected " + type + ", got " + val);
        }
      };
      for (const [fieldName, type] of Object.entries(validators))
        checkField(fieldName, type, false);
      for (const [fieldName, type] of Object.entries(optValidators))
        checkField(fieldName, type, true);
      return object;
    }
    function isHash(val) {
      return typeof val === "function" && Number.isSafeInteger(val.outputLen);
    }
    function _validateObject(object, fields, optFields = {}) {
      if (!object || typeof object !== "object")
        throw new Error("expected valid options object");
      function checkField(fieldName, expectedType, isOpt) {
        const val = object[fieldName];
        if (isOpt && val === void 0)
          return;
        const current = typeof val;
        if (current !== expectedType || val === null)
          throw new Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
      }
      Object.entries(fields).forEach(([k, v]) => checkField(k, v, false));
      Object.entries(optFields).forEach(([k, v]) => checkField(k, v, true));
    }
    var notImplemented = () => {
      throw new Error("not implemented");
    };
    exports.notImplemented = notImplemented;
    function memoized(fn) {
      const map = /* @__PURE__ */ new WeakMap();
      return (arg, ...args) => {
        const val = map.get(arg);
        if (val !== void 0)
          return val;
        const computed = fn(arg, ...args);
        map.set(arg, computed);
        return computed;
      };
    }
  }
});

// node_modules/@noble/curves/abstract/modular.js
var require_modular = __commonJS({
  "node_modules/@noble/curves/abstract/modular.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isNegativeLE = void 0;
    exports.mod = mod;
    exports.pow = pow;
    exports.pow2 = pow2;
    exports.invert = invert2;
    exports.tonelliShanks = tonelliShanks;
    exports.FpSqrt = FpSqrt;
    exports.validateField = validateField;
    exports.FpPow = FpPow;
    exports.FpInvertBatch = FpInvertBatch;
    exports.FpDiv = FpDiv;
    exports.FpLegendre = FpLegendre;
    exports.FpIsSquare = FpIsSquare;
    exports.nLength = nLength;
    exports.Field = Field;
    exports.FpSqrtOdd = FpSqrtOdd;
    exports.FpSqrtEven = FpSqrtEven;
    exports.hashToPrivateScalar = hashToPrivateScalar;
    exports.getFieldBytesLength = getFieldBytesLength;
    exports.getMinHashLength = getMinHashLength;
    exports.mapHashToField = mapHashToField;
    var utils_ts_1 = require_utils2();
    var _0n = BigInt(0);
    var _1n = BigInt(1);
    var _2n = /* @__PURE__ */ BigInt(2);
    var _3n = /* @__PURE__ */ BigInt(3);
    var _4n = /* @__PURE__ */ BigInt(4);
    var _5n = /* @__PURE__ */ BigInt(5);
    var _7n = /* @__PURE__ */ BigInt(7);
    var _8n = /* @__PURE__ */ BigInt(8);
    var _9n = /* @__PURE__ */ BigInt(9);
    var _16n = /* @__PURE__ */ BigInt(16);
    function mod(a, b) {
      const result = a % b;
      return result >= _0n ? result : b + result;
    }
    function pow(num, power, modulo) {
      return FpPow(Field(modulo), num, power);
    }
    function pow2(x, power, modulo) {
      let res = x;
      while (power-- > _0n) {
        res *= res;
        res %= modulo;
      }
      return res;
    }
    function invert2(number, modulo) {
      if (number === _0n)
        throw new Error("invert: expected non-zero number");
      if (modulo <= _0n)
        throw new Error("invert: expected positive modulus, got " + modulo);
      let a = mod(number, modulo);
      let b = modulo;
      let x = _0n, y = _1n, u = _1n, v = _0n;
      while (a !== _0n) {
        const q = b / a;
        const r = b % a;
        const m = x - u * q;
        const n = y - v * q;
        b = a, a = r, x = u, y = v, u = m, v = n;
      }
      const gcd = b;
      if (gcd !== _1n)
        throw new Error("invert: does not exist");
      return mod(x, modulo);
    }
    function assertIsSquare(Fp, root, n) {
      if (!Fp.eql(Fp.sqr(root), n))
        throw new Error("Cannot find square root");
    }
    function sqrt3mod4(Fp, n) {
      const p1div4 = (Fp.ORDER + _1n) / _4n;
      const root = Fp.pow(n, p1div4);
      assertIsSquare(Fp, root, n);
      return root;
    }
    function sqrt5mod8(Fp, n) {
      const p5div8 = (Fp.ORDER - _5n) / _8n;
      const n2 = Fp.mul(n, _2n);
      const v = Fp.pow(n2, p5div8);
      const nv = Fp.mul(n, v);
      const i = Fp.mul(Fp.mul(nv, _2n), v);
      const root = Fp.mul(nv, Fp.sub(i, Fp.ONE));
      assertIsSquare(Fp, root, n);
      return root;
    }
    function sqrt9mod16(P) {
      const Fp_ = Field(P);
      const tn = tonelliShanks(P);
      const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
      const c2 = tn(Fp_, c1);
      const c3 = tn(Fp_, Fp_.neg(c1));
      const c4 = (P + _7n) / _16n;
      return (Fp, n) => {
        let tv1 = Fp.pow(n, c4);
        let tv2 = Fp.mul(tv1, c1);
        const tv3 = Fp.mul(tv1, c2);
        const tv4 = Fp.mul(tv1, c3);
        const e1 = Fp.eql(Fp.sqr(tv2), n);
        const e2 = Fp.eql(Fp.sqr(tv3), n);
        tv1 = Fp.cmov(tv1, tv2, e1);
        tv2 = Fp.cmov(tv4, tv3, e2);
        const e3 = Fp.eql(Fp.sqr(tv2), n);
        const root = Fp.cmov(tv1, tv2, e3);
        assertIsSquare(Fp, root, n);
        return root;
      };
    }
    function tonelliShanks(P) {
      if (P < _3n)
        throw new Error("sqrt is not defined for small field");
      let Q = P - _1n;
      let S = 0;
      while (Q % _2n === _0n) {
        Q /= _2n;
        S++;
      }
      let Z = _2n;
      const _Fp = Field(P);
      while (FpLegendre(_Fp, Z) === 1) {
        if (Z++ > 1e3)
          throw new Error("Cannot find square root: probably non-prime P");
      }
      if (S === 1)
        return sqrt3mod4;
      let cc = _Fp.pow(Z, Q);
      const Q1div2 = (Q + _1n) / _2n;
      return function tonelliSlow(Fp, n) {
        if (Fp.is0(n))
          return n;
        if (FpLegendre(Fp, n) !== 1)
          throw new Error("Cannot find square root");
        let M = S;
        let c = Fp.mul(Fp.ONE, cc);
        let t = Fp.pow(n, Q);
        let R = Fp.pow(n, Q1div2);
        while (!Fp.eql(t, Fp.ONE)) {
          if (Fp.is0(t))
            return Fp.ZERO;
          let i = 1;
          let t_tmp = Fp.sqr(t);
          while (!Fp.eql(t_tmp, Fp.ONE)) {
            i++;
            t_tmp = Fp.sqr(t_tmp);
            if (i === M)
              throw new Error("Cannot find square root");
          }
          const exponent = _1n << BigInt(M - i - 1);
          const b = Fp.pow(c, exponent);
          M = i;
          c = Fp.sqr(b);
          t = Fp.mul(t, c);
          R = Fp.mul(R, b);
        }
        return R;
      };
    }
    function FpSqrt(P) {
      if (P % _4n === _3n)
        return sqrt3mod4;
      if (P % _8n === _5n)
        return sqrt5mod8;
      if (P % _16n === _9n)
        return sqrt9mod16(P);
      return tonelliShanks(P);
    }
    var isNegativeLE = (num, modulo) => (mod(num, modulo) & _1n) === _1n;
    exports.isNegativeLE = isNegativeLE;
    var FIELD_FIELDS = [
      "create",
      "isValid",
      "is0",
      "neg",
      "inv",
      "sqrt",
      "sqr",
      "eql",
      "add",
      "sub",
      "mul",
      "pow",
      "div",
      "addN",
      "subN",
      "mulN",
      "sqrN"
    ];
    function validateField(field) {
      const initial = {
        ORDER: "bigint",
        MASK: "bigint",
        BYTES: "number",
        BITS: "number"
      };
      const opts = FIELD_FIELDS.reduce((map, val) => {
        map[val] = "function";
        return map;
      }, initial);
      (0, utils_ts_1._validateObject)(field, opts);
      return field;
    }
    function FpPow(Fp, num, power) {
      if (power < _0n)
        throw new Error("invalid exponent, negatives unsupported");
      if (power === _0n)
        return Fp.ONE;
      if (power === _1n)
        return num;
      let p = Fp.ONE;
      let d = num;
      while (power > _0n) {
        if (power & _1n)
          p = Fp.mul(p, d);
        d = Fp.sqr(d);
        power >>= _1n;
      }
      return p;
    }
    function FpInvertBatch(Fp, nums, passZero = false) {
      const inverted = new Array(nums.length).fill(passZero ? Fp.ZERO : void 0);
      const multipliedAcc = nums.reduce((acc, num, i) => {
        if (Fp.is0(num))
          return acc;
        inverted[i] = acc;
        return Fp.mul(acc, num);
      }, Fp.ONE);
      const invertedAcc = Fp.inv(multipliedAcc);
      nums.reduceRight((acc, num, i) => {
        if (Fp.is0(num))
          return acc;
        inverted[i] = Fp.mul(acc, inverted[i]);
        return Fp.mul(acc, num);
      }, invertedAcc);
      return inverted;
    }
    function FpDiv(Fp, lhs, rhs) {
      return Fp.mul(lhs, typeof rhs === "bigint" ? invert2(rhs, Fp.ORDER) : Fp.inv(rhs));
    }
    function FpLegendre(Fp, n) {
      const p1mod2 = (Fp.ORDER - _1n) / _2n;
      const powered = Fp.pow(n, p1mod2);
      const yes = Fp.eql(powered, Fp.ONE);
      const zero = Fp.eql(powered, Fp.ZERO);
      const no = Fp.eql(powered, Fp.neg(Fp.ONE));
      if (!yes && !zero && !no)
        throw new Error("invalid Legendre symbol result");
      return yes ? 1 : zero ? 0 : -1;
    }
    function FpIsSquare(Fp, n) {
      const l = FpLegendre(Fp, n);
      return l === 1;
    }
    function nLength(n, nBitLength) {
      if (nBitLength !== void 0)
        (0, utils_ts_1.anumber)(nBitLength);
      const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;
      const nByteLength = Math.ceil(_nBitLength / 8);
      return { nBitLength: _nBitLength, nByteLength };
    }
    function Field(ORDER, bitLenOrOpts, isLE = false, opts = {}) {
      if (ORDER <= _0n)
        throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
      let _nbitLength = void 0;
      let _sqrt = void 0;
      let modFromBytes = false;
      let allowedLengths = void 0;
      if (typeof bitLenOrOpts === "object" && bitLenOrOpts != null) {
        if (opts.sqrt || isLE)
          throw new Error("cannot specify opts in two arguments");
        const _opts = bitLenOrOpts;
        if (_opts.BITS)
          _nbitLength = _opts.BITS;
        if (_opts.sqrt)
          _sqrt = _opts.sqrt;
        if (typeof _opts.isLE === "boolean")
          isLE = _opts.isLE;
        if (typeof _opts.modFromBytes === "boolean")
          modFromBytes = _opts.modFromBytes;
        allowedLengths = _opts.allowedLengths;
      } else {
        if (typeof bitLenOrOpts === "number")
          _nbitLength = bitLenOrOpts;
        if (opts.sqrt)
          _sqrt = opts.sqrt;
      }
      const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, _nbitLength);
      if (BYTES > 2048)
        throw new Error("invalid field: expected ORDER of <= 2048 bytes");
      let sqrtP;
      const f = Object.freeze({
        ORDER,
        isLE,
        BITS,
        BYTES,
        MASK: (0, utils_ts_1.bitMask)(BITS),
        ZERO: _0n,
        ONE: _1n,
        allowedLengths,
        create: (num) => mod(num, ORDER),
        isValid: (num) => {
          if (typeof num !== "bigint")
            throw new Error("invalid field element: expected bigint, got " + typeof num);
          return _0n <= num && num < ORDER;
        },
        is0: (num) => num === _0n,
        // is valid and invertible
        isValidNot0: (num) => !f.is0(num) && f.isValid(num),
        isOdd: (num) => (num & _1n) === _1n,
        neg: (num) => mod(-num, ORDER),
        eql: (lhs, rhs) => lhs === rhs,
        sqr: (num) => mod(num * num, ORDER),
        add: (lhs, rhs) => mod(lhs + rhs, ORDER),
        sub: (lhs, rhs) => mod(lhs - rhs, ORDER),
        mul: (lhs, rhs) => mod(lhs * rhs, ORDER),
        pow: (num, power) => FpPow(f, num, power),
        div: (lhs, rhs) => mod(lhs * invert2(rhs, ORDER), ORDER),
        // Same as above, but doesn't normalize
        sqrN: (num) => num * num,
        addN: (lhs, rhs) => lhs + rhs,
        subN: (lhs, rhs) => lhs - rhs,
        mulN: (lhs, rhs) => lhs * rhs,
        inv: (num) => invert2(num, ORDER),
        sqrt: _sqrt || ((n) => {
          if (!sqrtP)
            sqrtP = FpSqrt(ORDER);
          return sqrtP(f, n);
        }),
        toBytes: (num) => isLE ? (0, utils_ts_1.numberToBytesLE)(num, BYTES) : (0, utils_ts_1.numberToBytesBE)(num, BYTES),
        fromBytes: (bytes, skipValidation = true) => {
          if (allowedLengths) {
            if (!allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
              throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
            }
            const padded = new Uint8Array(BYTES);
            padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
            bytes = padded;
          }
          if (bytes.length !== BYTES)
            throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
          let scalar = isLE ? (0, utils_ts_1.bytesToNumberLE)(bytes) : (0, utils_ts_1.bytesToNumberBE)(bytes);
          if (modFromBytes)
            scalar = mod(scalar, ORDER);
          if (!skipValidation) {
            if (!f.isValid(scalar))
              throw new Error("invalid field element: outside of range 0..ORDER");
          }
          return scalar;
        },
        // TODO: we don't need it here, move out to separate fn
        invertBatch: (lst) => FpInvertBatch(f, lst),
        // We can't move this out because Fp6, Fp12 implement it
        // and it's unclear what to return in there.
        cmov: (a, b, c) => c ? b : a
      });
      return Object.freeze(f);
    }
    function FpSqrtOdd(Fp, elm) {
      if (!Fp.isOdd)
        throw new Error("Field doesn't have isOdd");
      const root = Fp.sqrt(elm);
      return Fp.isOdd(root) ? root : Fp.neg(root);
    }
    function FpSqrtEven(Fp, elm) {
      if (!Fp.isOdd)
        throw new Error("Field doesn't have isOdd");
      const root = Fp.sqrt(elm);
      return Fp.isOdd(root) ? Fp.neg(root) : root;
    }
    function hashToPrivateScalar(hash, groupOrder, isLE = false) {
      hash = (0, utils_ts_1.ensureBytes)("privateHash", hash);
      const hashLen = hash.length;
      const minLen = nLength(groupOrder).nByteLength + 8;
      if (minLen < 24 || hashLen < minLen || hashLen > 1024)
        throw new Error("hashToPrivateScalar: expected " + minLen + "-1024 bytes of input, got " + hashLen);
      const num = isLE ? (0, utils_ts_1.bytesToNumberLE)(hash) : (0, utils_ts_1.bytesToNumberBE)(hash);
      return mod(num, groupOrder - _1n) + _1n;
    }
    function getFieldBytesLength(fieldOrder) {
      if (typeof fieldOrder !== "bigint")
        throw new Error("field order must be bigint");
      const bitLength = fieldOrder.toString(2).length;
      return Math.ceil(bitLength / 8);
    }
    function getMinHashLength(fieldOrder) {
      const length = getFieldBytesLength(fieldOrder);
      return length + Math.ceil(length / 2);
    }
    function mapHashToField(key, fieldOrder, isLE = false) {
      const len = key.length;
      const fieldLen = getFieldBytesLength(fieldOrder);
      const minLen = getMinHashLength(fieldOrder);
      if (len < 16 || len < minLen || len > 1024)
        throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
      const num = isLE ? (0, utils_ts_1.bytesToNumberLE)(key) : (0, utils_ts_1.bytesToNumberBE)(key);
      const reduced = mod(num, fieldOrder - _1n) + _1n;
      return isLE ? (0, utils_ts_1.numberToBytesLE)(reduced, fieldLen) : (0, utils_ts_1.numberToBytesBE)(reduced, fieldLen);
    }
  }
});

// node_modules/@noble/curves/abstract/curve.js
var require_curve = __commonJS({
  "node_modules/@noble/curves/abstract/curve.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.wNAF = void 0;
    exports.negateCt = negateCt;
    exports.normalizeZ = normalizeZ;
    exports.mulEndoUnsafe = mulEndoUnsafe;
    exports.pippenger = pippenger;
    exports.precomputeMSMUnsafe = precomputeMSMUnsafe;
    exports.validateBasic = validateBasic;
    exports._createCurveFields = _createCurveFields;
    var utils_ts_1 = require_utils2();
    var modular_ts_1 = require_modular();
    var _0n = BigInt(0);
    var _1n = BigInt(1);
    function negateCt(condition, item) {
      const neg = item.negate();
      return condition ? neg : item;
    }
    function normalizeZ(c, points) {
      const invertedZs = (0, modular_ts_1.FpInvertBatch)(c.Fp, points.map((p) => p.Z));
      return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
    }
    function validateW(W, bits) {
      if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
        throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
    }
    function calcWOpts(W, scalarBits) {
      validateW(W, scalarBits);
      const windows = Math.ceil(scalarBits / W) + 1;
      const windowSize = 2 ** (W - 1);
      const maxNumber = 2 ** W;
      const mask = (0, utils_ts_1.bitMask)(W);
      const shiftBy = BigInt(W);
      return { windows, windowSize, mask, maxNumber, shiftBy };
    }
    function calcOffsets(n, window2, wOpts) {
      const { windowSize, mask, maxNumber, shiftBy } = wOpts;
      let wbits = Number(n & mask);
      let nextN = n >> shiftBy;
      if (wbits > windowSize) {
        wbits -= maxNumber;
        nextN += _1n;
      }
      const offsetStart = window2 * windowSize;
      const offset = offsetStart + Math.abs(wbits) - 1;
      const isZero = wbits === 0;
      const isNeg = wbits < 0;
      const isNegF = window2 % 2 !== 0;
      const offsetF = offsetStart;
      return { nextN, offset, isZero, isNeg, isNegF, offsetF };
    }
    function validateMSMPoints(points, c) {
      if (!Array.isArray(points))
        throw new Error("array expected");
      points.forEach((p, i) => {
        if (!(p instanceof c))
          throw new Error("invalid point at index " + i);
      });
    }
    function validateMSMScalars(scalars, field) {
      if (!Array.isArray(scalars))
        throw new Error("array of scalars expected");
      scalars.forEach((s, i) => {
        if (!field.isValid(s))
          throw new Error("invalid scalar at index " + i);
      });
    }
    var pointPrecomputes = /* @__PURE__ */ new WeakMap();
    var pointWindowSizes = /* @__PURE__ */ new WeakMap();
    function getW(P) {
      return pointWindowSizes.get(P) || 1;
    }
    function assert0(n) {
      if (n !== _0n)
        throw new Error("invalid wNAF");
    }
    var wNAF = class {
      // Parametrized with a given Point class (not individual point)
      constructor(Point, bits) {
        this.BASE = Point.BASE;
        this.ZERO = Point.ZERO;
        this.Fn = Point.Fn;
        this.bits = bits;
      }
      // non-const time multiplication ladder
      _unsafeLadder(elm, n, p = this.ZERO) {
        let d = elm;
        while (n > _0n) {
          if (n & _1n)
            p = p.add(d);
          d = d.double();
          n >>= _1n;
        }
        return p;
      }
      /**
       * Creates a wNAF precomputation window. Used for caching.
       * Default window size is set by `utils.precompute()` and is equal to 8.
       * Number of precomputed points depends on the curve size:
       * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
       * - 𝑊 is the window size
       * - 𝑛 is the bitlength of the curve order.
       * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
       * @param point Point instance
       * @param W window size
       * @returns precomputed point tables flattened to a single array
       */
      precomputeWindow(point, W) {
        const { windows, windowSize } = calcWOpts(W, this.bits);
        const points = [];
        let p = point;
        let base = p;
        for (let window2 = 0; window2 < windows; window2++) {
          base = p;
          points.push(base);
          for (let i = 1; i < windowSize; i++) {
            base = base.add(p);
            points.push(base);
          }
          p = base.double();
        }
        return points;
      }
      /**
       * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
       * More compact implementation:
       * https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541
       * @returns real and fake (for const-time) points
       */
      wNAF(W, precomputes, n) {
        if (!this.Fn.isValid(n))
          throw new Error("invalid scalar");
        let p = this.ZERO;
        let f = this.BASE;
        const wo = calcWOpts(W, this.bits);
        for (let window2 = 0; window2 < wo.windows; window2++) {
          const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window2, wo);
          n = nextN;
          if (isZero) {
            f = f.add(negateCt(isNegF, precomputes[offsetF]));
          } else {
            p = p.add(negateCt(isNeg, precomputes[offset]));
          }
        }
        assert0(n);
        return { p, f };
      }
      /**
       * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
       * @param acc accumulator point to add result of multiplication
       * @returns point
       */
      wNAFUnsafe(W, precomputes, n, acc = this.ZERO) {
        const wo = calcWOpts(W, this.bits);
        for (let window2 = 0; window2 < wo.windows; window2++) {
          if (n === _0n)
            break;
          const { nextN, offset, isZero, isNeg } = calcOffsets(n, window2, wo);
          n = nextN;
          if (isZero) {
            continue;
          } else {
            const item = precomputes[offset];
            acc = acc.add(isNeg ? item.negate() : item);
          }
        }
        assert0(n);
        return acc;
      }
      getPrecomputes(W, point, transform) {
        let comp = pointPrecomputes.get(point);
        if (!comp) {
          comp = this.precomputeWindow(point, W);
          if (W !== 1) {
            if (typeof transform === "function")
              comp = transform(comp);
            pointPrecomputes.set(point, comp);
          }
        }
        return comp;
      }
      cached(point, scalar, transform) {
        const W = getW(point);
        return this.wNAF(W, this.getPrecomputes(W, point, transform), scalar);
      }
      unsafe(point, scalar, transform, prev) {
        const W = getW(point);
        if (W === 1)
          return this._unsafeLadder(point, scalar, prev);
        return this.wNAFUnsafe(W, this.getPrecomputes(W, point, transform), scalar, prev);
      }
      // We calculate precomputes for elliptic curve point multiplication
      // using windowed method. This specifies window size and
      // stores precomputed values. Usually only base point would be precomputed.
      createCache(P, W) {
        validateW(W, this.bits);
        pointWindowSizes.set(P, W);
        pointPrecomputes.delete(P);
      }
      hasCache(elm) {
        return getW(elm) !== 1;
      }
    };
    exports.wNAF = wNAF;
    function mulEndoUnsafe(Point, point, k1, k2) {
      let acc = point;
      let p1 = Point.ZERO;
      let p2 = Point.ZERO;
      while (k1 > _0n || k2 > _0n) {
        if (k1 & _1n)
          p1 = p1.add(acc);
        if (k2 & _1n)
          p2 = p2.add(acc);
        acc = acc.double();
        k1 >>= _1n;
        k2 >>= _1n;
      }
      return { p1, p2 };
    }
    function pippenger(c, fieldN, points, scalars) {
      validateMSMPoints(points, c);
      validateMSMScalars(scalars, fieldN);
      const plength = points.length;
      const slength = scalars.length;
      if (plength !== slength)
        throw new Error("arrays of points and scalars must have equal length");
      const zero = c.ZERO;
      const wbits = (0, utils_ts_1.bitLen)(BigInt(plength));
      let windowSize = 1;
      if (wbits > 12)
        windowSize = wbits - 3;
      else if (wbits > 4)
        windowSize = wbits - 2;
      else if (wbits > 0)
        windowSize = 2;
      const MASK = (0, utils_ts_1.bitMask)(windowSize);
      const buckets = new Array(Number(MASK) + 1).fill(zero);
      const lastBits = Math.floor((fieldN.BITS - 1) / windowSize) * windowSize;
      let sum = zero;
      for (let i = lastBits; i >= 0; i -= windowSize) {
        buckets.fill(zero);
        for (let j = 0; j < slength; j++) {
          const scalar = scalars[j];
          const wbits2 = Number(scalar >> BigInt(i) & MASK);
          buckets[wbits2] = buckets[wbits2].add(points[j]);
        }
        let resI = zero;
        for (let j = buckets.length - 1, sumI = zero; j > 0; j--) {
          sumI = sumI.add(buckets[j]);
          resI = resI.add(sumI);
        }
        sum = sum.add(resI);
        if (i !== 0)
          for (let j = 0; j < windowSize; j++)
            sum = sum.double();
      }
      return sum;
    }
    function precomputeMSMUnsafe(c, fieldN, points, windowSize) {
      validateW(windowSize, fieldN.BITS);
      validateMSMPoints(points, c);
      const zero = c.ZERO;
      const tableSize = 2 ** windowSize - 1;
      const chunks = Math.ceil(fieldN.BITS / windowSize);
      const MASK = (0, utils_ts_1.bitMask)(windowSize);
      const tables = points.map((p) => {
        const res = [];
        for (let i = 0, acc = p; i < tableSize; i++) {
          res.push(acc);
          acc = acc.add(p);
        }
        return res;
      });
      return (scalars) => {
        validateMSMScalars(scalars, fieldN);
        if (scalars.length > points.length)
          throw new Error("array of scalars must be smaller than array of points");
        let res = zero;
        for (let i = 0; i < chunks; i++) {
          if (res !== zero)
            for (let j = 0; j < windowSize; j++)
              res = res.double();
          const shiftBy = BigInt(chunks * windowSize - (i + 1) * windowSize);
          for (let j = 0; j < scalars.length; j++) {
            const n = scalars[j];
            const curr = Number(n >> shiftBy & MASK);
            if (!curr)
              continue;
            res = res.add(tables[j][curr - 1]);
          }
        }
        return res;
      };
    }
    function validateBasic(curve) {
      (0, modular_ts_1.validateField)(curve.Fp);
      (0, utils_ts_1.validateObject)(curve, {
        n: "bigint",
        h: "bigint",
        Gx: "field",
        Gy: "field"
      }, {
        nBitLength: "isSafeInteger",
        nByteLength: "isSafeInteger"
      });
      return Object.freeze({
        ...(0, modular_ts_1.nLength)(curve.n, curve.nBitLength),
        ...curve,
        ...{ p: curve.Fp.ORDER }
      });
    }
    function createField(order, field, isLE) {
      if (field) {
        if (field.ORDER !== order)
          throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
        (0, modular_ts_1.validateField)(field);
        return field;
      } else {
        return (0, modular_ts_1.Field)(order, { isLE });
      }
    }
    function _createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
      if (FpFnLE === void 0)
        FpFnLE = type === "edwards";
      if (!CURVE || typeof CURVE !== "object")
        throw new Error(`expected valid ${type} CURVE object`);
      for (const p of ["p", "n", "h"]) {
        const val = CURVE[p];
        if (!(typeof val === "bigint" && val > _0n))
          throw new Error(`CURVE.${p} must be positive bigint`);
      }
      const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);
      const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
      const _b = type === "weierstrass" ? "b" : "d";
      const params = ["Gx", "Gy", "a", _b];
      for (const p of params) {
        if (!Fp.isValid(CURVE[p]))
          throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
      }
      CURVE = Object.freeze(Object.assign({}, CURVE));
      return { CURVE, Fp, Fn };
    }
  }
});

// node_modules/@noble/curves/abstract/edwards.js
var require_edwards = __commonJS({
  "node_modules/@noble/curves/abstract/edwards.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PrimeEdwardsPoint = void 0;
    exports.edwards = edwards;
    exports.eddsa = eddsa;
    exports.twistedEdwards = twistedEdwards;
    var utils_ts_1 = require_utils2();
    var curve_ts_1 = require_curve();
    var modular_ts_1 = require_modular();
    var _0n = BigInt(0);
    var _1n = BigInt(1);
    var _2n = BigInt(2);
    var _8n = BigInt(8);
    function isEdValidXY(Fp, CURVE, x, y) {
      const x2 = Fp.sqr(x);
      const y2 = Fp.sqr(y);
      const left = Fp.add(Fp.mul(CURVE.a, x2), y2);
      const right = Fp.add(Fp.ONE, Fp.mul(CURVE.d, Fp.mul(x2, y2)));
      return Fp.eql(left, right);
    }
    function edwards(params, extraOpts = {}) {
      const validated = (0, curve_ts_1._createCurveFields)("edwards", params, extraOpts, extraOpts.FpFnLE);
      const { Fp, Fn } = validated;
      let CURVE = validated.CURVE;
      const { h: cofactor } = CURVE;
      (0, utils_ts_1._validateObject)(extraOpts, {}, { uvRatio: "function" });
      const MASK = _2n << BigInt(Fn.BYTES * 8) - _1n;
      const modP = (n) => Fp.create(n);
      const uvRatio = extraOpts.uvRatio || ((u, v) => {
        try {
          return { isValid: true, value: Fp.sqrt(Fp.div(u, v)) };
        } catch (e) {
          return { isValid: false, value: _0n };
        }
      });
      if (!isEdValidXY(Fp, CURVE, CURVE.Gx, CURVE.Gy))
        throw new Error("bad curve params: generator point");
      function acoord(title, n, banZero = false) {
        const min = banZero ? _1n : _0n;
        (0, utils_ts_1.aInRange)("coordinate " + title, n, min, MASK);
        return n;
      }
      function aextpoint(other) {
        if (!(other instanceof Point))
          throw new Error("ExtendedPoint expected");
      }
      const toAffineMemo = (0, utils_ts_1.memoized)((p, iz) => {
        const { X, Y, Z } = p;
        const is0 = p.is0();
        if (iz == null)
          iz = is0 ? _8n : Fp.inv(Z);
        const x = modP(X * iz);
        const y = modP(Y * iz);
        const zz = Fp.mul(Z, iz);
        if (is0)
          return { x: _0n, y: _1n };
        if (zz !== _1n)
          throw new Error("invZ was invalid");
        return { x, y };
      });
      const assertValidMemo = (0, utils_ts_1.memoized)((p) => {
        const { a, d } = CURVE;
        if (p.is0())
          throw new Error("bad point: ZERO");
        const { X, Y, Z, T } = p;
        const X2 = modP(X * X);
        const Y2 = modP(Y * Y);
        const Z2 = modP(Z * Z);
        const Z4 = modP(Z2 * Z2);
        const aX2 = modP(X2 * a);
        const left = modP(Z2 * modP(aX2 + Y2));
        const right = modP(Z4 + modP(d * modP(X2 * Y2)));
        if (left !== right)
          throw new Error("bad point: equation left != right (1)");
        const XY = modP(X * Y);
        const ZT = modP(Z * T);
        if (XY !== ZT)
          throw new Error("bad point: equation left != right (2)");
        return true;
      });
      class Point {
        constructor(X, Y, Z, T) {
          this.X = acoord("x", X);
          this.Y = acoord("y", Y);
          this.Z = acoord("z", Z, true);
          this.T = acoord("t", T);
          Object.freeze(this);
        }
        static CURVE() {
          return CURVE;
        }
        static fromAffine(p) {
          if (p instanceof Point)
            throw new Error("extended point not allowed");
          const { x, y } = p || {};
          acoord("x", x);
          acoord("y", y);
          return new Point(x, y, _1n, modP(x * y));
        }
        // Uses algo from RFC8032 5.1.3.
        static fromBytes(bytes, zip215 = false) {
          const len = Fp.BYTES;
          const { a, d } = CURVE;
          bytes = (0, utils_ts_1.copyBytes)((0, utils_ts_1._abytes2)(bytes, len, "point"));
          (0, utils_ts_1._abool2)(zip215, "zip215");
          const normed = (0, utils_ts_1.copyBytes)(bytes);
          const lastByte = bytes[len - 1];
          normed[len - 1] = lastByte & ~128;
          const y = (0, utils_ts_1.bytesToNumberLE)(normed);
          const max = zip215 ? MASK : Fp.ORDER;
          (0, utils_ts_1.aInRange)("point.y", y, _0n, max);
          const y2 = modP(y * y);
          const u = modP(y2 - _1n);
          const v = modP(d * y2 - a);
          let { isValid, value: x } = uvRatio(u, v);
          if (!isValid)
            throw new Error("bad point: invalid y coordinate");
          const isXOdd = (x & _1n) === _1n;
          const isLastByteOdd = (lastByte & 128) !== 0;
          if (!zip215 && x === _0n && isLastByteOdd)
            throw new Error("bad point: x=0 and x_0=1");
          if (isLastByteOdd !== isXOdd)
            x = modP(-x);
          return Point.fromAffine({ x, y });
        }
        static fromHex(bytes, zip215 = false) {
          return Point.fromBytes((0, utils_ts_1.ensureBytes)("point", bytes), zip215);
        }
        get x() {
          return this.toAffine().x;
        }
        get y() {
          return this.toAffine().y;
        }
        precompute(windowSize = 8, isLazy = true) {
          wnaf.createCache(this, windowSize);
          if (!isLazy)
            this.multiply(_2n);
          return this;
        }
        // Useful in fromAffine() - not for fromBytes(), which always created valid points.
        assertValidity() {
          assertValidMemo(this);
        }
        // Compare one point to another.
        equals(other) {
          aextpoint(other);
          const { X: X1, Y: Y1, Z: Z1 } = this;
          const { X: X2, Y: Y2, Z: Z2 } = other;
          const X1Z2 = modP(X1 * Z2);
          const X2Z1 = modP(X2 * Z1);
          const Y1Z2 = modP(Y1 * Z2);
          const Y2Z1 = modP(Y2 * Z1);
          return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
        }
        is0() {
          return this.equals(Point.ZERO);
        }
        negate() {
          return new Point(modP(-this.X), this.Y, this.Z, modP(-this.T));
        }
        // Fast algo for doubling Extended Point.
        // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#doubling-dbl-2008-hwcd
        // Cost: 4M + 4S + 1*a + 6add + 1*2.
        double() {
          const { a } = CURVE;
          const { X: X1, Y: Y1, Z: Z1 } = this;
          const A = modP(X1 * X1);
          const B = modP(Y1 * Y1);
          const C = modP(_2n * modP(Z1 * Z1));
          const D = modP(a * A);
          const x1y1 = X1 + Y1;
          const E = modP(modP(x1y1 * x1y1) - A - B);
          const G = D + B;
          const F = G - C;
          const H = D - B;
          const X3 = modP(E * F);
          const Y3 = modP(G * H);
          const T3 = modP(E * H);
          const Z3 = modP(F * G);
          return new Point(X3, Y3, Z3, T3);
        }
        // Fast algo for adding 2 Extended Points.
        // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#addition-add-2008-hwcd
        // Cost: 9M + 1*a + 1*d + 7add.
        add(other) {
          aextpoint(other);
          const { a, d } = CURVE;
          const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
          const { X: X2, Y: Y2, Z: Z2, T: T2 } = other;
          const A = modP(X1 * X2);
          const B = modP(Y1 * Y2);
          const C = modP(T1 * d * T2);
          const D = modP(Z1 * Z2);
          const E = modP((X1 + Y1) * (X2 + Y2) - A - B);
          const F = D - C;
          const G = D + C;
          const H = modP(B - a * A);
          const X3 = modP(E * F);
          const Y3 = modP(G * H);
          const T3 = modP(E * H);
          const Z3 = modP(F * G);
          return new Point(X3, Y3, Z3, T3);
        }
        subtract(other) {
          return this.add(other.negate());
        }
        // Constant-time multiplication.
        multiply(scalar) {
          if (!Fn.isValidNot0(scalar))
            throw new Error("invalid scalar: expected 1 <= sc < curve.n");
          const { p, f } = wnaf.cached(this, scalar, (p2) => (0, curve_ts_1.normalizeZ)(Point, p2));
          return (0, curve_ts_1.normalizeZ)(Point, [p, f])[0];
        }
        // Non-constant-time multiplication. Uses double-and-add algorithm.
        // It's faster, but should only be used when you don't care about
        // an exposed private key e.g. sig verification.
        // Does NOT allow scalars higher than CURVE.n.
        // Accepts optional accumulator to merge with multiply (important for sparse scalars)
        multiplyUnsafe(scalar, acc = Point.ZERO) {
          if (!Fn.isValid(scalar))
            throw new Error("invalid scalar: expected 0 <= sc < curve.n");
          if (scalar === _0n)
            return Point.ZERO;
          if (this.is0() || scalar === _1n)
            return this;
          return wnaf.unsafe(this, scalar, (p) => (0, curve_ts_1.normalizeZ)(Point, p), acc);
        }
        // Checks if point is of small order.
        // If you add something to small order point, you will have "dirty"
        // point with torsion component.
        // Multiplies point by cofactor and checks if the result is 0.
        isSmallOrder() {
          return this.multiplyUnsafe(cofactor).is0();
        }
        // Multiplies point by curve order and checks if the result is 0.
        // Returns `false` is the point is dirty.
        isTorsionFree() {
          return wnaf.unsafe(this, CURVE.n).is0();
        }
        // Converts Extended point to default (x, y) coordinates.
        // Can accept precomputed Z^-1 - for example, from invertBatch.
        toAffine(invertedZ) {
          return toAffineMemo(this, invertedZ);
        }
        clearCofactor() {
          if (cofactor === _1n)
            return this;
          return this.multiplyUnsafe(cofactor);
        }
        toBytes() {
          const { x, y } = this.toAffine();
          const bytes = Fp.toBytes(y);
          bytes[bytes.length - 1] |= x & _1n ? 128 : 0;
          return bytes;
        }
        toHex() {
          return (0, utils_ts_1.bytesToHex)(this.toBytes());
        }
        toString() {
          return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
        }
        // TODO: remove
        get ex() {
          return this.X;
        }
        get ey() {
          return this.Y;
        }
        get ez() {
          return this.Z;
        }
        get et() {
          return this.T;
        }
        static normalizeZ(points) {
          return (0, curve_ts_1.normalizeZ)(Point, points);
        }
        static msm(points, scalars) {
          return (0, curve_ts_1.pippenger)(Point, Fn, points, scalars);
        }
        _setWindowSize(windowSize) {
          this.precompute(windowSize);
        }
        toRawBytes() {
          return this.toBytes();
        }
      }
      Point.BASE = new Point(CURVE.Gx, CURVE.Gy, _1n, modP(CURVE.Gx * CURVE.Gy));
      Point.ZERO = new Point(_0n, _1n, _1n, _0n);
      Point.Fp = Fp;
      Point.Fn = Fn;
      const wnaf = new curve_ts_1.wNAF(Point, Fn.BITS);
      Point.BASE.precompute(8);
      return Point;
    }
    var PrimeEdwardsPoint = class {
      constructor(ep) {
        this.ep = ep;
      }
      // Static methods that must be implemented by subclasses
      static fromBytes(_bytes) {
        (0, utils_ts_1.notImplemented)();
      }
      static fromHex(_hex) {
        (0, utils_ts_1.notImplemented)();
      }
      get x() {
        return this.toAffine().x;
      }
      get y() {
        return this.toAffine().y;
      }
      // Common implementations
      clearCofactor() {
        return this;
      }
      assertValidity() {
        this.ep.assertValidity();
      }
      toAffine(invertedZ) {
        return this.ep.toAffine(invertedZ);
      }
      toHex() {
        return (0, utils_ts_1.bytesToHex)(this.toBytes());
      }
      toString() {
        return this.toHex();
      }
      isTorsionFree() {
        return true;
      }
      isSmallOrder() {
        return false;
      }
      add(other) {
        this.assertSame(other);
        return this.init(this.ep.add(other.ep));
      }
      subtract(other) {
        this.assertSame(other);
        return this.init(this.ep.subtract(other.ep));
      }
      multiply(scalar) {
        return this.init(this.ep.multiply(scalar));
      }
      multiplyUnsafe(scalar) {
        return this.init(this.ep.multiplyUnsafe(scalar));
      }
      double() {
        return this.init(this.ep.double());
      }
      negate() {
        return this.init(this.ep.negate());
      }
      precompute(windowSize, isLazy) {
        return this.init(this.ep.precompute(windowSize, isLazy));
      }
      /** @deprecated use `toBytes` */
      toRawBytes() {
        return this.toBytes();
      }
    };
    exports.PrimeEdwardsPoint = PrimeEdwardsPoint;
    function eddsa(Point, cHash, eddsaOpts = {}) {
      if (typeof cHash !== "function")
        throw new Error('"hash" function param is required');
      (0, utils_ts_1._validateObject)(eddsaOpts, {}, {
        adjustScalarBytes: "function",
        randomBytes: "function",
        domain: "function",
        prehash: "function",
        mapToCurve: "function"
      });
      const { prehash } = eddsaOpts;
      const { BASE, Fp, Fn } = Point;
      const randomBytes = eddsaOpts.randomBytes || utils_ts_1.randomBytes;
      const adjustScalarBytes = eddsaOpts.adjustScalarBytes || ((bytes) => bytes);
      const domain = eddsaOpts.domain || ((data, ctx, phflag) => {
        (0, utils_ts_1._abool2)(phflag, "phflag");
        if (ctx.length || phflag)
          throw new Error("Contexts/pre-hash are not supported");
        return data;
      });
      function modN_LE(hash) {
        return Fn.create((0, utils_ts_1.bytesToNumberLE)(hash));
      }
      function getPrivateScalar(key) {
        const len = lengths.secretKey;
        key = (0, utils_ts_1.ensureBytes)("private key", key, len);
        const hashed = (0, utils_ts_1.ensureBytes)("hashed private key", cHash(key), 2 * len);
        const head = adjustScalarBytes(hashed.slice(0, len));
        const prefix = hashed.slice(len, 2 * len);
        const scalar = modN_LE(head);
        return { head, prefix, scalar };
      }
      function getExtendedPublicKey(secretKey) {
        const { head, prefix, scalar } = getPrivateScalar(secretKey);
        const point = BASE.multiply(scalar);
        const pointBytes = point.toBytes();
        return { head, prefix, scalar, point, pointBytes };
      }
      function getPublicKey(secretKey) {
        return getExtendedPublicKey(secretKey).pointBytes;
      }
      function hashDomainToScalar(context = Uint8Array.of(), ...msgs) {
        const msg = (0, utils_ts_1.concatBytes)(...msgs);
        return modN_LE(cHash(domain(msg, (0, utils_ts_1.ensureBytes)("context", context), !!prehash)));
      }
      function sign(msg, secretKey, options = {}) {
        msg = (0, utils_ts_1.ensureBytes)("message", msg);
        if (prehash)
          msg = prehash(msg);
        const { prefix, scalar, pointBytes } = getExtendedPublicKey(secretKey);
        const r = hashDomainToScalar(options.context, prefix, msg);
        const R = BASE.multiply(r).toBytes();
        const k = hashDomainToScalar(options.context, R, pointBytes, msg);
        const s = Fn.create(r + k * scalar);
        if (!Fn.isValid(s))
          throw new Error("sign failed: invalid s");
        const rs = (0, utils_ts_1.concatBytes)(R, Fn.toBytes(s));
        return (0, utils_ts_1._abytes2)(rs, lengths.signature, "result");
      }
      const verifyOpts = { zip215: true };
      function verify(sig, msg, publicKey, options = verifyOpts) {
        const { context, zip215 } = options;
        const len = lengths.signature;
        sig = (0, utils_ts_1.ensureBytes)("signature", sig, len);
        msg = (0, utils_ts_1.ensureBytes)("message", msg);
        publicKey = (0, utils_ts_1.ensureBytes)("publicKey", publicKey, lengths.publicKey);
        if (zip215 !== void 0)
          (0, utils_ts_1._abool2)(zip215, "zip215");
        if (prehash)
          msg = prehash(msg);
        const mid = len / 2;
        const r = sig.subarray(0, mid);
        const s = (0, utils_ts_1.bytesToNumberLE)(sig.subarray(mid, len));
        let A, R, SB;
        try {
          A = Point.fromBytes(publicKey, zip215);
          R = Point.fromBytes(r, zip215);
          SB = BASE.multiplyUnsafe(s);
        } catch (error) {
          return false;
        }
        if (!zip215 && A.isSmallOrder())
          return false;
        const k = hashDomainToScalar(context, R.toBytes(), A.toBytes(), msg);
        const RkA = R.add(A.multiplyUnsafe(k));
        return RkA.subtract(SB).clearCofactor().is0();
      }
      const _size = Fp.BYTES;
      const lengths = {
        secretKey: _size,
        publicKey: _size,
        signature: 2 * _size,
        seed: _size
      };
      function randomSecretKey(seed = randomBytes(lengths.seed)) {
        return (0, utils_ts_1._abytes2)(seed, lengths.seed, "seed");
      }
      function keygen(seed) {
        const secretKey = utils.randomSecretKey(seed);
        return { secretKey, publicKey: getPublicKey(secretKey) };
      }
      function isValidSecretKey(key) {
        return (0, utils_ts_1.isBytes)(key) && key.length === Fn.BYTES;
      }
      function isValidPublicKey(key, zip215) {
        try {
          return !!Point.fromBytes(key, zip215);
        } catch (error) {
          return false;
        }
      }
      const utils = {
        getExtendedPublicKey,
        randomSecretKey,
        isValidSecretKey,
        isValidPublicKey,
        /**
         * Converts ed public key to x public key. Uses formula:
         * - ed25519:
         *   - `(u, v) = ((1+y)/(1-y), sqrt(-486664)*u/x)`
         *   - `(x, y) = (sqrt(-486664)*u/v, (u-1)/(u+1))`
         * - ed448:
         *   - `(u, v) = ((y-1)/(y+1), sqrt(156324)*u/x)`
         *   - `(x, y) = (sqrt(156324)*u/v, (1+u)/(1-u))`
         */
        toMontgomery(publicKey) {
          const { y } = Point.fromBytes(publicKey);
          const size = lengths.publicKey;
          const is25519 = size === 32;
          if (!is25519 && size !== 57)
            throw new Error("only defined for 25519 and 448");
          const u = is25519 ? Fp.div(_1n + y, _1n - y) : Fp.div(y - _1n, y + _1n);
          return Fp.toBytes(u);
        },
        toMontgomerySecret(secretKey) {
          const size = lengths.secretKey;
          (0, utils_ts_1._abytes2)(secretKey, size);
          const hashed = cHash(secretKey.subarray(0, size));
          return adjustScalarBytes(hashed).subarray(0, size);
        },
        /** @deprecated */
        randomPrivateKey: randomSecretKey,
        /** @deprecated */
        precompute(windowSize = 8, point = Point.BASE) {
          return point.precompute(windowSize, false);
        }
      };
      return Object.freeze({
        keygen,
        getPublicKey,
        sign,
        verify,
        utils,
        Point,
        lengths
      });
    }
    function _eddsa_legacy_opts_to_new(c) {
      const CURVE = {
        a: c.a,
        d: c.d,
        p: c.Fp.ORDER,
        n: c.n,
        h: c.h,
        Gx: c.Gx,
        Gy: c.Gy
      };
      const Fp = c.Fp;
      const Fn = (0, modular_ts_1.Field)(CURVE.n, c.nBitLength, true);
      const curveOpts = { Fp, Fn, uvRatio: c.uvRatio };
      const eddsaOpts = {
        randomBytes: c.randomBytes,
        adjustScalarBytes: c.adjustScalarBytes,
        domain: c.domain,
        prehash: c.prehash,
        mapToCurve: c.mapToCurve
      };
      return { CURVE, curveOpts, hash: c.hash, eddsaOpts };
    }
    function _eddsa_new_output_to_legacy(c, eddsa2) {
      const Point = eddsa2.Point;
      const legacy = Object.assign({}, eddsa2, {
        ExtendedPoint: Point,
        CURVE: c,
        nBitLength: Point.Fn.BITS,
        nByteLength: Point.Fn.BYTES
      });
      return legacy;
    }
    function twistedEdwards(c) {
      const { CURVE, curveOpts, hash, eddsaOpts } = _eddsa_legacy_opts_to_new(c);
      const Point = edwards(CURVE, curveOpts);
      const EDDSA = eddsa(Point, hash, eddsaOpts);
      return _eddsa_new_output_to_legacy(c, EDDSA);
    }
  }
});

// node_modules/@noble/curves/abstract/hash-to-curve.js
var require_hash_to_curve = __commonJS({
  "node_modules/@noble/curves/abstract/hash-to-curve.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports._DST_scalar = void 0;
    exports.expand_message_xmd = expand_message_xmd;
    exports.expand_message_xof = expand_message_xof;
    exports.hash_to_field = hash_to_field;
    exports.isogenyMap = isogenyMap;
    exports.createHasher = createHasher;
    var utils_ts_1 = require_utils2();
    var modular_ts_1 = require_modular();
    var os2ip = utils_ts_1.bytesToNumberBE;
    function i2osp(value, length) {
      anum(value);
      anum(length);
      if (value < 0 || value >= 1 << 8 * length)
        throw new Error("invalid I2OSP input: " + value);
      const res = Array.from({ length }).fill(0);
      for (let i = length - 1; i >= 0; i--) {
        res[i] = value & 255;
        value >>>= 8;
      }
      return new Uint8Array(res);
    }
    function strxor(a, b) {
      const arr = new Uint8Array(a.length);
      for (let i = 0; i < a.length; i++) {
        arr[i] = a[i] ^ b[i];
      }
      return arr;
    }
    function anum(item) {
      if (!Number.isSafeInteger(item))
        throw new Error("number expected");
    }
    function normDST(DST) {
      if (!(0, utils_ts_1.isBytes)(DST) && typeof DST !== "string")
        throw new Error("DST must be Uint8Array or string");
      return typeof DST === "string" ? (0, utils_ts_1.utf8ToBytes)(DST) : DST;
    }
    function expand_message_xmd(msg, DST, lenInBytes, H) {
      (0, utils_ts_1.abytes)(msg);
      anum(lenInBytes);
      DST = normDST(DST);
      if (DST.length > 255)
        DST = H((0, utils_ts_1.concatBytes)((0, utils_ts_1.utf8ToBytes)("H2C-OVERSIZE-DST-"), DST));
      const { outputLen: b_in_bytes, blockLen: r_in_bytes } = H;
      const ell = Math.ceil(lenInBytes / b_in_bytes);
      if (lenInBytes > 65535 || ell > 255)
        throw new Error("expand_message_xmd: invalid lenInBytes");
      const DST_prime = (0, utils_ts_1.concatBytes)(DST, i2osp(DST.length, 1));
      const Z_pad = i2osp(0, r_in_bytes);
      const l_i_b_str = i2osp(lenInBytes, 2);
      const b = new Array(ell);
      const b_0 = H((0, utils_ts_1.concatBytes)(Z_pad, msg, l_i_b_str, i2osp(0, 1), DST_prime));
      b[0] = H((0, utils_ts_1.concatBytes)(b_0, i2osp(1, 1), DST_prime));
      for (let i = 1; i <= ell; i++) {
        const args = [strxor(b_0, b[i - 1]), i2osp(i + 1, 1), DST_prime];
        b[i] = H((0, utils_ts_1.concatBytes)(...args));
      }
      const pseudo_random_bytes = (0, utils_ts_1.concatBytes)(...b);
      return pseudo_random_bytes.slice(0, lenInBytes);
    }
    function expand_message_xof(msg, DST, lenInBytes, k, H) {
      (0, utils_ts_1.abytes)(msg);
      anum(lenInBytes);
      DST = normDST(DST);
      if (DST.length > 255) {
        const dkLen = Math.ceil(2 * k / 8);
        DST = H.create({ dkLen }).update((0, utils_ts_1.utf8ToBytes)("H2C-OVERSIZE-DST-")).update(DST).digest();
      }
      if (lenInBytes > 65535 || DST.length > 255)
        throw new Error("expand_message_xof: invalid lenInBytes");
      return H.create({ dkLen: lenInBytes }).update(msg).update(i2osp(lenInBytes, 2)).update(DST).update(i2osp(DST.length, 1)).digest();
    }
    function hash_to_field(msg, count, options) {
      (0, utils_ts_1._validateObject)(options, {
        p: "bigint",
        m: "number",
        k: "number",
        hash: "function"
      });
      const { p, k, m, hash, expand, DST } = options;
      if (!(0, utils_ts_1.isHash)(options.hash))
        throw new Error("expected valid hash");
      (0, utils_ts_1.abytes)(msg);
      anum(count);
      const log2p = p.toString(2).length;
      const L = Math.ceil((log2p + k) / 8);
      const len_in_bytes = count * m * L;
      let prb;
      if (expand === "xmd") {
        prb = expand_message_xmd(msg, DST, len_in_bytes, hash);
      } else if (expand === "xof") {
        prb = expand_message_xof(msg, DST, len_in_bytes, k, hash);
      } else if (expand === "_internal_pass") {
        prb = msg;
      } else {
        throw new Error('expand must be "xmd" or "xof"');
      }
      const u = new Array(count);
      for (let i = 0; i < count; i++) {
        const e = new Array(m);
        for (let j = 0; j < m; j++) {
          const elm_offset = L * (j + i * m);
          const tv = prb.subarray(elm_offset, elm_offset + L);
          e[j] = (0, modular_ts_1.mod)(os2ip(tv), p);
        }
        u[i] = e;
      }
      return u;
    }
    function isogenyMap(field, map) {
      const coeff = map.map((i) => Array.from(i).reverse());
      return (x, y) => {
        const [xn, xd, yn, yd] = coeff.map((val) => val.reduce((acc, i) => field.add(field.mul(acc, x), i)));
        const [xd_inv, yd_inv] = (0, modular_ts_1.FpInvertBatch)(field, [xd, yd], true);
        x = field.mul(xn, xd_inv);
        y = field.mul(y, field.mul(yn, yd_inv));
        return { x, y };
      };
    }
    exports._DST_scalar = (0, utils_ts_1.utf8ToBytes)("HashToScalar-");
    function createHasher(Point, mapToCurve, defaults) {
      if (typeof mapToCurve !== "function")
        throw new Error("mapToCurve() must be defined");
      function map(num) {
        return Point.fromAffine(mapToCurve(num));
      }
      function clear(initial) {
        const P = initial.clearCofactor();
        if (P.equals(Point.ZERO))
          return Point.ZERO;
        P.assertValidity();
        return P;
      }
      return {
        defaults,
        hashToCurve(msg, options) {
          const opts = Object.assign({}, defaults, options);
          const u = hash_to_field(msg, 2, opts);
          const u0 = map(u[0]);
          const u1 = map(u[1]);
          return clear(u0.add(u1));
        },
        encodeToCurve(msg, options) {
          const optsDst = defaults.encodeDST ? { DST: defaults.encodeDST } : {};
          const opts = Object.assign({}, defaults, optsDst, options);
          const u = hash_to_field(msg, 1, opts);
          const u0 = map(u[0]);
          return clear(u0);
        },
        /** See {@link H2CHasher} */
        mapToCurve(scalars) {
          if (!Array.isArray(scalars))
            throw new Error("expected array of bigints");
          for (const i of scalars)
            if (typeof i !== "bigint")
              throw new Error("expected array of bigints");
          return clear(map(scalars));
        },
        // hash_to_scalar can produce 0: https://www.rfc-editor.org/errata/eid8393
        // RFC 9380, draft-irtf-cfrg-bbs-signatures-08
        hashToScalar(msg, options) {
          const N = Point.Fn.ORDER;
          const opts = Object.assign({}, defaults, { p: N, m: 1, DST: exports._DST_scalar }, options);
          return hash_to_field(msg, 1, opts)[0][0];
        }
      };
    }
  }
});

// node_modules/@noble/curves/abstract/montgomery.js
var require_montgomery = __commonJS({
  "node_modules/@noble/curves/abstract/montgomery.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.montgomery = montgomery;
    var utils_ts_1 = require_utils2();
    var modular_ts_1 = require_modular();
    var _0n = BigInt(0);
    var _1n = BigInt(1);
    var _2n = BigInt(2);
    function validateOpts(curve) {
      (0, utils_ts_1._validateObject)(curve, {
        adjustScalarBytes: "function",
        powPminus2: "function"
      });
      return Object.freeze({ ...curve });
    }
    function montgomery(curveDef) {
      const CURVE = validateOpts(curveDef);
      const { P, type, adjustScalarBytes, powPminus2, randomBytes: rand } = CURVE;
      const is25519 = type === "x25519";
      if (!is25519 && type !== "x448")
        throw new Error("invalid type");
      const randomBytes_ = rand || utils_ts_1.randomBytes;
      const montgomeryBits = is25519 ? 255 : 448;
      const fieldLen = is25519 ? 32 : 56;
      const Gu = is25519 ? BigInt(9) : BigInt(5);
      const a24 = is25519 ? BigInt(121665) : BigInt(39081);
      const minScalar = is25519 ? _2n ** BigInt(254) : _2n ** BigInt(447);
      const maxAdded = is25519 ? BigInt(8) * _2n ** BigInt(251) - _1n : BigInt(4) * _2n ** BigInt(445) - _1n;
      const maxScalar = minScalar + maxAdded + _1n;
      const modP = (n) => (0, modular_ts_1.mod)(n, P);
      const GuBytes = encodeU(Gu);
      function encodeU(u) {
        return (0, utils_ts_1.numberToBytesLE)(modP(u), fieldLen);
      }
      function decodeU(u) {
        const _u = (0, utils_ts_1.ensureBytes)("u coordinate", u, fieldLen);
        if (is25519)
          _u[31] &= 127;
        return modP((0, utils_ts_1.bytesToNumberLE)(_u));
      }
      function decodeScalar(scalar) {
        return (0, utils_ts_1.bytesToNumberLE)(adjustScalarBytes((0, utils_ts_1.ensureBytes)("scalar", scalar, fieldLen)));
      }
      function scalarMult(scalar, u) {
        const pu = montgomeryLadder(decodeU(u), decodeScalar(scalar));
        if (pu === _0n)
          throw new Error("invalid private or public key received");
        return encodeU(pu);
      }
      function scalarMultBase(scalar) {
        return scalarMult(scalar, GuBytes);
      }
      function cswap(swap, x_2, x_3) {
        const dummy = modP(swap * (x_2 - x_3));
        x_2 = modP(x_2 - dummy);
        x_3 = modP(x_3 + dummy);
        return { x_2, x_3 };
      }
      function montgomeryLadder(u, scalar) {
        (0, utils_ts_1.aInRange)("u", u, _0n, P);
        (0, utils_ts_1.aInRange)("scalar", scalar, minScalar, maxScalar);
        const k = scalar;
        const x_1 = u;
        let x_2 = _1n;
        let z_2 = _0n;
        let x_3 = u;
        let z_3 = _1n;
        let swap = _0n;
        for (let t = BigInt(montgomeryBits - 1); t >= _0n; t--) {
          const k_t = k >> t & _1n;
          swap ^= k_t;
          ({ x_2, x_3 } = cswap(swap, x_2, x_3));
          ({ x_2: z_2, x_3: z_3 } = cswap(swap, z_2, z_3));
          swap = k_t;
          const A = x_2 + z_2;
          const AA = modP(A * A);
          const B = x_2 - z_2;
          const BB = modP(B * B);
          const E = AA - BB;
          const C = x_3 + z_3;
          const D = x_3 - z_3;
          const DA = modP(D * A);
          const CB = modP(C * B);
          const dacb = DA + CB;
          const da_cb = DA - CB;
          x_3 = modP(dacb * dacb);
          z_3 = modP(x_1 * modP(da_cb * da_cb));
          x_2 = modP(AA * BB);
          z_2 = modP(E * (AA + modP(a24 * E)));
        }
        ({ x_2, x_3 } = cswap(swap, x_2, x_3));
        ({ x_2: z_2, x_3: z_3 } = cswap(swap, z_2, z_3));
        const z2 = powPminus2(z_2);
        return modP(x_2 * z2);
      }
      const lengths = {
        secretKey: fieldLen,
        publicKey: fieldLen,
        seed: fieldLen
      };
      const randomSecretKey = (seed = randomBytes_(fieldLen)) => {
        (0, utils_ts_1.abytes)(seed, lengths.seed);
        return seed;
      };
      function keygen(seed) {
        const secretKey = randomSecretKey(seed);
        return { secretKey, publicKey: scalarMultBase(secretKey) };
      }
      const utils = {
        randomSecretKey,
        randomPrivateKey: randomSecretKey
      };
      return {
        keygen,
        getSharedSecret: (secretKey, publicKey) => scalarMult(secretKey, publicKey),
        getPublicKey: (secretKey) => scalarMultBase(secretKey),
        scalarMult,
        scalarMultBase,
        utils,
        GuBytes: GuBytes.slice(),
        lengths
      };
    }
  }
});

// node_modules/@noble/curves/ed25519.js
var require_ed25519 = __commonJS({
  "node_modules/@noble/curves/ed25519.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.hash_to_ristretto255 = exports.hashToRistretto255 = exports.encodeToCurve = exports.hashToCurve = exports.RistrettoPoint = exports.edwardsToMontgomery = exports.ED25519_TORSION_SUBGROUP = exports.ristretto255_hasher = exports.ristretto255 = exports.ed25519_hasher = exports.x25519 = exports.ed25519ph = exports.ed25519ctx = exports.ed25519 = void 0;
    exports.edwardsToMontgomeryPub = edwardsToMontgomeryPub;
    exports.edwardsToMontgomeryPriv = edwardsToMontgomeryPriv;
    var sha2_js_1 = require_sha2();
    var utils_js_1 = require_utils();
    var curve_ts_1 = require_curve();
    var edwards_ts_1 = require_edwards();
    var hash_to_curve_ts_1 = require_hash_to_curve();
    var modular_ts_1 = require_modular();
    var montgomery_ts_1 = require_montgomery();
    var utils_ts_1 = require_utils2();
    var _0n = /* @__PURE__ */ BigInt(0);
    var _1n = BigInt(1);
    var _2n = BigInt(2);
    var _3n = BigInt(3);
    var _5n = BigInt(5);
    var _8n = BigInt(8);
    var ed25519_CURVE_p = BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed");
    var ed25519_CURVE = /* @__PURE__ */ (() => ({
      p: ed25519_CURVE_p,
      n: BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"),
      h: _8n,
      a: BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec"),
      d: BigInt("0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3"),
      Gx: BigInt("0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a"),
      Gy: BigInt("0x6666666666666666666666666666666666666666666666666666666666666658")
    }))();
    function ed25519_pow_2_252_3(x) {
      const _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
      const P = ed25519_CURVE_p;
      const x2 = x * x % P;
      const b2 = x2 * x % P;
      const b4 = (0, modular_ts_1.pow2)(b2, _2n, P) * b2 % P;
      const b5 = (0, modular_ts_1.pow2)(b4, _1n, P) * x % P;
      const b10 = (0, modular_ts_1.pow2)(b5, _5n, P) * b5 % P;
      const b20 = (0, modular_ts_1.pow2)(b10, _10n, P) * b10 % P;
      const b40 = (0, modular_ts_1.pow2)(b20, _20n, P) * b20 % P;
      const b80 = (0, modular_ts_1.pow2)(b40, _40n, P) * b40 % P;
      const b160 = (0, modular_ts_1.pow2)(b80, _80n, P) * b80 % P;
      const b240 = (0, modular_ts_1.pow2)(b160, _80n, P) * b80 % P;
      const b250 = (0, modular_ts_1.pow2)(b240, _10n, P) * b10 % P;
      const pow_p_5_8 = (0, modular_ts_1.pow2)(b250, _2n, P) * x % P;
      return { pow_p_5_8, b2 };
    }
    function adjustScalarBytes(bytes) {
      bytes[0] &= 248;
      bytes[31] &= 127;
      bytes[31] |= 64;
      return bytes;
    }
    var ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
    function uvRatio(u, v) {
      const P = ed25519_CURVE_p;
      const v3 = (0, modular_ts_1.mod)(v * v * v, P);
      const v7 = (0, modular_ts_1.mod)(v3 * v3 * v, P);
      const pow = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
      let x = (0, modular_ts_1.mod)(u * v3 * pow, P);
      const vx2 = (0, modular_ts_1.mod)(v * x * x, P);
      const root1 = x;
      const root2 = (0, modular_ts_1.mod)(x * ED25519_SQRT_M1, P);
      const useRoot1 = vx2 === u;
      const useRoot2 = vx2 === (0, modular_ts_1.mod)(-u, P);
      const noRoot = vx2 === (0, modular_ts_1.mod)(-u * ED25519_SQRT_M1, P);
      if (useRoot1)
        x = root1;
      if (useRoot2 || noRoot)
        x = root2;
      if ((0, modular_ts_1.isNegativeLE)(x, P))
        x = (0, modular_ts_1.mod)(-x, P);
      return { isValid: useRoot1 || useRoot2, value: x };
    }
    var Fp = /* @__PURE__ */ (() => (0, modular_ts_1.Field)(ed25519_CURVE.p, { isLE: true }))();
    var Fn = /* @__PURE__ */ (() => (0, modular_ts_1.Field)(ed25519_CURVE.n, { isLE: true }))();
    var ed25519Defaults = /* @__PURE__ */ (() => ({
      ...ed25519_CURVE,
      Fp,
      hash: sha2_js_1.sha512,
      adjustScalarBytes,
      // dom2
      // Ratio of u to v. Allows us to combine inversion and square root. Uses algo from RFC8032 5.1.3.
      // Constant-time, u/√v
      uvRatio
    }))();
    exports.ed25519 = (() => (0, edwards_ts_1.twistedEdwards)(ed25519Defaults))();
    function ed25519_domain(data, ctx, phflag) {
      if (ctx.length > 255)
        throw new Error("Context is too big");
      return (0, utils_js_1.concatBytes)((0, utils_js_1.utf8ToBytes)("SigEd25519 no Ed25519 collisions"), new Uint8Array([phflag ? 1 : 0, ctx.length]), ctx, data);
    }
    exports.ed25519ctx = (() => (0, edwards_ts_1.twistedEdwards)({
      ...ed25519Defaults,
      domain: ed25519_domain
    }))();
    exports.ed25519ph = (() => (0, edwards_ts_1.twistedEdwards)(Object.assign({}, ed25519Defaults, {
      domain: ed25519_domain,
      prehash: sha2_js_1.sha512
    })))();
    exports.x25519 = (() => {
      const P = Fp.ORDER;
      return (0, montgomery_ts_1.montgomery)({
        P,
        type: "x25519",
        powPminus2: (x) => {
          const { pow_p_5_8, b2 } = ed25519_pow_2_252_3(x);
          return (0, modular_ts_1.mod)((0, modular_ts_1.pow2)(pow_p_5_8, _3n, P) * b2, P);
        },
        adjustScalarBytes
      });
    })();
    var ELL2_C1 = /* @__PURE__ */ (() => (ed25519_CURVE_p + _3n) / _8n)();
    var ELL2_C2 = /* @__PURE__ */ (() => Fp.pow(_2n, ELL2_C1))();
    var ELL2_C3 = /* @__PURE__ */ (() => Fp.sqrt(Fp.neg(Fp.ONE)))();
    function map_to_curve_elligator2_curve25519(u) {
      const ELL2_C4 = (ed25519_CURVE_p - _5n) / _8n;
      const ELL2_J = BigInt(486662);
      let tv1 = Fp.sqr(u);
      tv1 = Fp.mul(tv1, _2n);
      let xd = Fp.add(tv1, Fp.ONE);
      let x1n = Fp.neg(ELL2_J);
      let tv2 = Fp.sqr(xd);
      let gxd = Fp.mul(tv2, xd);
      let gx1 = Fp.mul(tv1, ELL2_J);
      gx1 = Fp.mul(gx1, x1n);
      gx1 = Fp.add(gx1, tv2);
      gx1 = Fp.mul(gx1, x1n);
      let tv3 = Fp.sqr(gxd);
      tv2 = Fp.sqr(tv3);
      tv3 = Fp.mul(tv3, gxd);
      tv3 = Fp.mul(tv3, gx1);
      tv2 = Fp.mul(tv2, tv3);
      let y11 = Fp.pow(tv2, ELL2_C4);
      y11 = Fp.mul(y11, tv3);
      let y12 = Fp.mul(y11, ELL2_C3);
      tv2 = Fp.sqr(y11);
      tv2 = Fp.mul(tv2, gxd);
      let e1 = Fp.eql(tv2, gx1);
      let y1 = Fp.cmov(y12, y11, e1);
      let x2n = Fp.mul(x1n, tv1);
      let y21 = Fp.mul(y11, u);
      y21 = Fp.mul(y21, ELL2_C2);
      let y22 = Fp.mul(y21, ELL2_C3);
      let gx2 = Fp.mul(gx1, tv1);
      tv2 = Fp.sqr(y21);
      tv2 = Fp.mul(tv2, gxd);
      let e2 = Fp.eql(tv2, gx2);
      let y2 = Fp.cmov(y22, y21, e2);
      tv2 = Fp.sqr(y1);
      tv2 = Fp.mul(tv2, gxd);
      let e3 = Fp.eql(tv2, gx1);
      let xn = Fp.cmov(x2n, x1n, e3);
      let y = Fp.cmov(y2, y1, e3);
      let e4 = Fp.isOdd(y);
      y = Fp.cmov(y, Fp.neg(y), e3 !== e4);
      return { xMn: xn, xMd: xd, yMn: y, yMd: _1n };
    }
    var ELL2_C1_EDWARDS = /* @__PURE__ */ (() => (0, modular_ts_1.FpSqrtEven)(Fp, Fp.neg(BigInt(486664))))();
    function map_to_curve_elligator2_edwards25519(u) {
      const { xMn, xMd, yMn, yMd } = map_to_curve_elligator2_curve25519(u);
      let xn = Fp.mul(xMn, yMd);
      xn = Fp.mul(xn, ELL2_C1_EDWARDS);
      let xd = Fp.mul(xMd, yMn);
      let yn = Fp.sub(xMn, xMd);
      let yd = Fp.add(xMn, xMd);
      let tv1 = Fp.mul(xd, yd);
      let e = Fp.eql(tv1, Fp.ZERO);
      xn = Fp.cmov(xn, Fp.ZERO, e);
      xd = Fp.cmov(xd, Fp.ONE, e);
      yn = Fp.cmov(yn, Fp.ONE, e);
      yd = Fp.cmov(yd, Fp.ONE, e);
      const [xd_inv, yd_inv] = (0, modular_ts_1.FpInvertBatch)(Fp, [xd, yd], true);
      return { x: Fp.mul(xn, xd_inv), y: Fp.mul(yn, yd_inv) };
    }
    exports.ed25519_hasher = (() => (0, hash_to_curve_ts_1.createHasher)(exports.ed25519.Point, (scalars) => map_to_curve_elligator2_edwards25519(scalars[0]), {
      DST: "edwards25519_XMD:SHA-512_ELL2_RO_",
      encodeDST: "edwards25519_XMD:SHA-512_ELL2_NU_",
      p: ed25519_CURVE_p,
      m: 1,
      k: 128,
      expand: "xmd",
      hash: sha2_js_1.sha512
    }))();
    var SQRT_M1 = ED25519_SQRT_M1;
    var SQRT_AD_MINUS_ONE = /* @__PURE__ */ BigInt("25063068953384623474111414158702152701244531502492656460079210482610430750235");
    var INVSQRT_A_MINUS_D = /* @__PURE__ */ BigInt("54469307008909316920995813868745141605393597292927456921205312896311721017578");
    var ONE_MINUS_D_SQ = /* @__PURE__ */ BigInt("1159843021668779879193775521855586647937357759715417654439879720876111806838");
    var D_MINUS_ONE_SQ = /* @__PURE__ */ BigInt("40440834346308536858101042469323190826248399146238708352240133220865137265952");
    var invertSqrt = (number) => uvRatio(_1n, number);
    var MAX_255B = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    var bytes255ToNumberLE = (bytes) => exports.ed25519.Point.Fp.create((0, utils_ts_1.bytesToNumberLE)(bytes) & MAX_255B);
    function calcElligatorRistrettoMap(r0) {
      const { d } = ed25519_CURVE;
      const P = ed25519_CURVE_p;
      const mod = (n) => Fp.create(n);
      const r = mod(SQRT_M1 * r0 * r0);
      const Ns = mod((r + _1n) * ONE_MINUS_D_SQ);
      let c = BigInt(-1);
      const D = mod((c - d * r) * mod(r + d));
      let { isValid: Ns_D_is_sq, value: s } = uvRatio(Ns, D);
      let s_ = mod(s * r0);
      if (!(0, modular_ts_1.isNegativeLE)(s_, P))
        s_ = mod(-s_);
      if (!Ns_D_is_sq)
        s = s_;
      if (!Ns_D_is_sq)
        c = r;
      const Nt = mod(c * (r - _1n) * D_MINUS_ONE_SQ - D);
      const s2 = s * s;
      const W0 = mod((s + s) * D);
      const W1 = mod(Nt * SQRT_AD_MINUS_ONE);
      const W2 = mod(_1n - s2);
      const W3 = mod(_1n + s2);
      return new exports.ed25519.Point(mod(W0 * W3), mod(W2 * W1), mod(W1 * W3), mod(W0 * W2));
    }
    function ristretto255_map(bytes) {
      (0, utils_js_1.abytes)(bytes, 64);
      const r1 = bytes255ToNumberLE(bytes.subarray(0, 32));
      const R1 = calcElligatorRistrettoMap(r1);
      const r2 = bytes255ToNumberLE(bytes.subarray(32, 64));
      const R2 = calcElligatorRistrettoMap(r2);
      return new _RistrettoPoint(R1.add(R2));
    }
    var _RistrettoPoint = class __RistrettoPoint extends edwards_ts_1.PrimeEdwardsPoint {
      constructor(ep) {
        super(ep);
      }
      static fromAffine(ap) {
        return new __RistrettoPoint(exports.ed25519.Point.fromAffine(ap));
      }
      assertSame(other) {
        if (!(other instanceof __RistrettoPoint))
          throw new Error("RistrettoPoint expected");
      }
      init(ep) {
        return new __RistrettoPoint(ep);
      }
      /** @deprecated use `import { ristretto255_hasher } from '@noble/curves/ed25519.js';` */
      static hashToCurve(hex) {
        return ristretto255_map((0, utils_ts_1.ensureBytes)("ristrettoHash", hex, 64));
      }
      static fromBytes(bytes) {
        (0, utils_js_1.abytes)(bytes, 32);
        const { a, d } = ed25519_CURVE;
        const P = ed25519_CURVE_p;
        const mod = (n) => Fp.create(n);
        const s = bytes255ToNumberLE(bytes);
        if (!(0, utils_ts_1.equalBytes)(Fp.toBytes(s), bytes) || (0, modular_ts_1.isNegativeLE)(s, P))
          throw new Error("invalid ristretto255 encoding 1");
        const s2 = mod(s * s);
        const u1 = mod(_1n + a * s2);
        const u2 = mod(_1n - a * s2);
        const u1_2 = mod(u1 * u1);
        const u2_2 = mod(u2 * u2);
        const v = mod(a * d * u1_2 - u2_2);
        const { isValid, value: I } = invertSqrt(mod(v * u2_2));
        const Dx = mod(I * u2);
        const Dy = mod(I * Dx * v);
        let x = mod((s + s) * Dx);
        if ((0, modular_ts_1.isNegativeLE)(x, P))
          x = mod(-x);
        const y = mod(u1 * Dy);
        const t = mod(x * y);
        if (!isValid || (0, modular_ts_1.isNegativeLE)(t, P) || y === _0n)
          throw new Error("invalid ristretto255 encoding 2");
        return new __RistrettoPoint(new exports.ed25519.Point(x, y, _1n, t));
      }
      /**
       * Converts ristretto-encoded string to ristretto point.
       * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-decode).
       * @param hex Ristretto-encoded 32 bytes. Not every 32-byte string is valid ristretto encoding
       */
      static fromHex(hex) {
        return __RistrettoPoint.fromBytes((0, utils_ts_1.ensureBytes)("ristrettoHex", hex, 32));
      }
      static msm(points, scalars) {
        return (0, curve_ts_1.pippenger)(__RistrettoPoint, exports.ed25519.Point.Fn, points, scalars);
      }
      /**
       * Encodes ristretto point to Uint8Array.
       * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-encode).
       */
      toBytes() {
        let { X, Y, Z, T } = this.ep;
        const P = ed25519_CURVE_p;
        const mod = (n) => Fp.create(n);
        const u1 = mod(mod(Z + Y) * mod(Z - Y));
        const u2 = mod(X * Y);
        const u2sq = mod(u2 * u2);
        const { value: invsqrt } = invertSqrt(mod(u1 * u2sq));
        const D1 = mod(invsqrt * u1);
        const D2 = mod(invsqrt * u2);
        const zInv = mod(D1 * D2 * T);
        let D;
        if ((0, modular_ts_1.isNegativeLE)(T * zInv, P)) {
          let _x = mod(Y * SQRT_M1);
          let _y = mod(X * SQRT_M1);
          X = _x;
          Y = _y;
          D = mod(D1 * INVSQRT_A_MINUS_D);
        } else {
          D = D2;
        }
        if ((0, modular_ts_1.isNegativeLE)(X * zInv, P))
          Y = mod(-Y);
        let s = mod((Z - Y) * D);
        if ((0, modular_ts_1.isNegativeLE)(s, P))
          s = mod(-s);
        return Fp.toBytes(s);
      }
      /**
       * Compares two Ristretto points.
       * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-equals).
       */
      equals(other) {
        this.assertSame(other);
        const { X: X1, Y: Y1 } = this.ep;
        const { X: X2, Y: Y2 } = other.ep;
        const mod = (n) => Fp.create(n);
        const one = mod(X1 * Y2) === mod(Y1 * X2);
        const two = mod(Y1 * Y2) === mod(X1 * X2);
        return one || two;
      }
      is0() {
        return this.equals(__RistrettoPoint.ZERO);
      }
    };
    _RistrettoPoint.BASE = /* @__PURE__ */ (() => new _RistrettoPoint(exports.ed25519.Point.BASE))();
    _RistrettoPoint.ZERO = /* @__PURE__ */ (() => new _RistrettoPoint(exports.ed25519.Point.ZERO))();
    _RistrettoPoint.Fp = /* @__PURE__ */ (() => Fp)();
    _RistrettoPoint.Fn = /* @__PURE__ */ (() => Fn)();
    exports.ristretto255 = { Point: _RistrettoPoint };
    exports.ristretto255_hasher = {
      hashToCurve(msg, options) {
        const DST = options?.DST || "ristretto255_XMD:SHA-512_R255MAP_RO_";
        const xmd = (0, hash_to_curve_ts_1.expand_message_xmd)(msg, DST, 64, sha2_js_1.sha512);
        return ristretto255_map(xmd);
      },
      hashToScalar(msg, options = { DST: hash_to_curve_ts_1._DST_scalar }) {
        const xmd = (0, hash_to_curve_ts_1.expand_message_xmd)(msg, options.DST, 64, sha2_js_1.sha512);
        return Fn.create((0, utils_ts_1.bytesToNumberLE)(xmd));
      }
    };
    exports.ED25519_TORSION_SUBGROUP = [
      "0100000000000000000000000000000000000000000000000000000000000000",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
      "0000000000000000000000000000000000000000000000000000000000000080",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
      "0000000000000000000000000000000000000000000000000000000000000000",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa"
    ];
    function edwardsToMontgomeryPub(edwardsPub) {
      return exports.ed25519.utils.toMontgomery((0, utils_ts_1.ensureBytes)("pub", edwardsPub));
    }
    exports.edwardsToMontgomery = edwardsToMontgomeryPub;
    function edwardsToMontgomeryPriv(edwardsPriv) {
      return exports.ed25519.utils.toMontgomerySecret((0, utils_ts_1.ensureBytes)("pub", edwardsPriv));
    }
    exports.RistrettoPoint = _RistrettoPoint;
    exports.hashToCurve = (() => exports.ed25519_hasher.hashToCurve)();
    exports.encodeToCurve = (() => exports.ed25519_hasher.encodeToCurve)();
    exports.hashToRistretto255 = (() => exports.ristretto255_hasher.hashToCurve)();
    exports.hash_to_ristretto255 = (() => exports.ristretto255_hasher.hashToCurve)();
  }
});

// node_modules/@noble/hashes/sha3.js
var require_sha3 = __commonJS({
  "node_modules/@noble/hashes/sha3.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.shake256 = exports.shake128 = exports.keccak_512 = exports.keccak_384 = exports.keccak_256 = exports.keccak_224 = exports.sha3_512 = exports.sha3_384 = exports.sha3_256 = exports.sha3_224 = exports.Keccak = void 0;
    exports.keccakP = keccakP;
    var _u64_ts_1 = require_u64();
    var utils_ts_1 = require_utils();
    var _0n = BigInt(0);
    var _1n = BigInt(1);
    var _2n = BigInt(2);
    var _7n = BigInt(7);
    var _256n = BigInt(256);
    var _0x71n = BigInt(113);
    var SHA3_PI = [];
    var SHA3_ROTL = [];
    var _SHA3_IOTA = [];
    for (let round = 0, R = _1n, x = 1, y = 0; round < 24; round++) {
      [x, y] = [y, (2 * x + 3 * y) % 5];
      SHA3_PI.push(2 * (5 * y + x));
      SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
      let t = _0n;
      for (let j = 0; j < 7; j++) {
        R = (R << _1n ^ (R >> _7n) * _0x71n) % _256n;
        if (R & _2n)
          t ^= _1n << (_1n << /* @__PURE__ */ BigInt(j)) - _1n;
      }
      _SHA3_IOTA.push(t);
    }
    var IOTAS = (0, _u64_ts_1.split)(_SHA3_IOTA, true);
    var SHA3_IOTA_H = IOTAS[0];
    var SHA3_IOTA_L = IOTAS[1];
    var rotlH = (h, l, s) => s > 32 ? (0, _u64_ts_1.rotlBH)(h, l, s) : (0, _u64_ts_1.rotlSH)(h, l, s);
    var rotlL = (h, l, s) => s > 32 ? (0, _u64_ts_1.rotlBL)(h, l, s) : (0, _u64_ts_1.rotlSL)(h, l, s);
    function keccakP(s, rounds = 24) {
      const B = new Uint32Array(5 * 2);
      for (let round = 24 - rounds; round < 24; round++) {
        for (let x = 0; x < 10; x++)
          B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
        for (let x = 0; x < 10; x += 2) {
          const idx1 = (x + 8) % 10;
          const idx0 = (x + 2) % 10;
          const B0 = B[idx0];
          const B1 = B[idx0 + 1];
          const Th = rotlH(B0, B1, 1) ^ B[idx1];
          const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
          for (let y = 0; y < 50; y += 10) {
            s[x + y] ^= Th;
            s[x + y + 1] ^= Tl;
          }
        }
        let curH = s[2];
        let curL = s[3];
        for (let t = 0; t < 24; t++) {
          const shift = SHA3_ROTL[t];
          const Th = rotlH(curH, curL, shift);
          const Tl = rotlL(curH, curL, shift);
          const PI = SHA3_PI[t];
          curH = s[PI];
          curL = s[PI + 1];
          s[PI] = Th;
          s[PI + 1] = Tl;
        }
        for (let y = 0; y < 50; y += 10) {
          for (let x = 0; x < 10; x++)
            B[x] = s[y + x];
          for (let x = 0; x < 10; x++)
            s[y + x] ^= ~B[(x + 2) % 10] & B[(x + 4) % 10];
        }
        s[0] ^= SHA3_IOTA_H[round];
        s[1] ^= SHA3_IOTA_L[round];
      }
      (0, utils_ts_1.clean)(B);
    }
    var Keccak = class _Keccak extends utils_ts_1.Hash {
      // NOTE: we accept arguments in bytes instead of bits here.
      constructor(blockLen, suffix, outputLen, enableXOF = false, rounds = 24) {
        super();
        this.pos = 0;
        this.posOut = 0;
        this.finished = false;
        this.destroyed = false;
        this.enableXOF = false;
        this.blockLen = blockLen;
        this.suffix = suffix;
        this.outputLen = outputLen;
        this.enableXOF = enableXOF;
        this.rounds = rounds;
        (0, utils_ts_1.anumber)(outputLen);
        if (!(0 < blockLen && blockLen < 200))
          throw new Error("only keccak-f1600 function is supported");
        this.state = new Uint8Array(200);
        this.state32 = (0, utils_ts_1.u32)(this.state);
      }
      clone() {
        return this._cloneInto();
      }
      keccak() {
        (0, utils_ts_1.swap32IfBE)(this.state32);
        keccakP(this.state32, this.rounds);
        (0, utils_ts_1.swap32IfBE)(this.state32);
        this.posOut = 0;
        this.pos = 0;
      }
      update(data) {
        (0, utils_ts_1.aexists)(this);
        data = (0, utils_ts_1.toBytes)(data);
        (0, utils_ts_1.abytes)(data);
        const { blockLen, state } = this;
        const len = data.length;
        for (let pos = 0; pos < len; ) {
          const take = Math.min(blockLen - this.pos, len - pos);
          for (let i = 0; i < take; i++)
            state[this.pos++] ^= data[pos++];
          if (this.pos === blockLen)
            this.keccak();
        }
        return this;
      }
      finish() {
        if (this.finished)
          return;
        this.finished = true;
        const { state, suffix, pos, blockLen } = this;
        state[pos] ^= suffix;
        if ((suffix & 128) !== 0 && pos === blockLen - 1)
          this.keccak();
        state[blockLen - 1] ^= 128;
        this.keccak();
      }
      writeInto(out) {
        (0, utils_ts_1.aexists)(this, false);
        (0, utils_ts_1.abytes)(out);
        this.finish();
        const bufferOut = this.state;
        const { blockLen } = this;
        for (let pos = 0, len = out.length; pos < len; ) {
          if (this.posOut >= blockLen)
            this.keccak();
          const take = Math.min(blockLen - this.posOut, len - pos);
          out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
          this.posOut += take;
          pos += take;
        }
        return out;
      }
      xofInto(out) {
        if (!this.enableXOF)
          throw new Error("XOF is not possible for this instance");
        return this.writeInto(out);
      }
      xof(bytes) {
        (0, utils_ts_1.anumber)(bytes);
        return this.xofInto(new Uint8Array(bytes));
      }
      digestInto(out) {
        (0, utils_ts_1.aoutput)(out, this);
        if (this.finished)
          throw new Error("digest() was already called");
        this.writeInto(out);
        this.destroy();
        return out;
      }
      digest() {
        return this.digestInto(new Uint8Array(this.outputLen));
      }
      destroy() {
        this.destroyed = true;
        (0, utils_ts_1.clean)(this.state);
      }
      _cloneInto(to) {
        const { blockLen, suffix, outputLen, rounds, enableXOF } = this;
        to || (to = new _Keccak(blockLen, suffix, outputLen, enableXOF, rounds));
        to.state32.set(this.state32);
        to.pos = this.pos;
        to.posOut = this.posOut;
        to.finished = this.finished;
        to.rounds = rounds;
        to.suffix = suffix;
        to.outputLen = outputLen;
        to.enableXOF = enableXOF;
        to.destroyed = this.destroyed;
        return to;
      }
    };
    exports.Keccak = Keccak;
    var gen = (suffix, blockLen, outputLen) => (0, utils_ts_1.createHasher)(() => new Keccak(blockLen, suffix, outputLen));
    exports.sha3_224 = (() => gen(6, 144, 224 / 8))();
    exports.sha3_256 = (() => gen(6, 136, 256 / 8))();
    exports.sha3_384 = (() => gen(6, 104, 384 / 8))();
    exports.sha3_512 = (() => gen(6, 72, 512 / 8))();
    exports.keccak_224 = (() => gen(1, 144, 224 / 8))();
    exports.keccak_256 = (() => gen(1, 136, 256 / 8))();
    exports.keccak_384 = (() => gen(1, 104, 384 / 8))();
    exports.keccak_512 = (() => gen(1, 72, 512 / 8))();
    var genShake = (suffix, blockLen, outputLen) => (0, utils_ts_1.createXOFer)((opts = {}) => new Keccak(blockLen, suffix, opts.dkLen === void 0 ? outputLen : opts.dkLen, true));
    exports.shake128 = (() => genShake(31, 168, 128 / 8))();
    exports.shake256 = (() => genShake(31, 136, 256 / 8))();
  }
});

// web/vendor/rescue.mjs
var import_ed25519 = __toESM(require_ed25519(), 1);
var import_sha3 = __toESM(require_sha3(), 1);
var import_modular = __toESM(require_modular(), 1);
function serializeLE(val, lengthInBytes) {
  const result = new Uint8Array(lengthInBytes);
  let tempVal = val;
  for (let i = 0; i < lengthInBytes; i++) {
    result[i] = Number(tempVal & BigInt(255));
    tempVal >>= BigInt(8);
  }
  if (tempVal > BigInt(0)) {
    throw new Error(`Value ${val} is too large for the byte length ${lengthInBytes}`);
  }
  return result;
}
function deserializeLE(bytes) {
  let result = BigInt(0);
  for (let i = 0; i < bytes.length; i++) {
    result |= BigInt(bytes[i]) << BigInt(i) * BigInt(8);
  }
  return result;
}
function toBinLE(x, binSize) {
  const res = [];
  for (let i = 0; i < binSize; ++i) {
    res.push(ctSignBit(x, BigInt(i)));
  }
  return res;
}
function fromBinLE(xBin) {
  let res = 0n;
  for (let i = 0; i < xBin.length - 1; ++i) {
    res |= BigInt(xBin[i]) << BigInt(i);
  }
  return res - (BigInt(xBin[xBin.length - 1]) << BigInt(xBin.length - 1));
}
function adder(xBin, yBin, carryIn, binSize) {
  const res = [];
  let carry = carryIn;
  for (let i = 0; i < binSize; ++i) {
    const yXorCarry = yBin[i] !== carry;
    res.push(xBin[i] !== yXorCarry);
    const newCarry = yBin[i] !== (yXorCarry && xBin[i] !== yBin[i]);
    carry = newCarry;
  }
  return res;
}
function ctAdd(x, y, binSize) {
  const resBin = adder(toBinLE(x, binSize), toBinLE(y, binSize), false, binSize);
  return fromBinLE(resBin);
}
function ctSub(x, y, binSize) {
  const yBin = toBinLE(y, binSize);
  const yBinNot = [];
  for (let i = 0; i < binSize; ++i) {
    yBinNot.push(yBin[i] === false);
  }
  const resBin = adder(toBinLE(x, binSize), yBinNot, true, binSize);
  return fromBinLE(resBin);
}
function ctSignBit(x, binSize) {
  return (x >> binSize & 1n) === 1n;
}
function ctLt(x, y, binSize) {
  return ctSignBit(ctSub(x, y, binSize), binSize);
}
function ctSelect(b, x, y, binSize) {
  return ctAdd(y, BigInt(b) * ctSub(x, y, binSize), binSize);
}
function verifyBinSize(x, binSize) {
  const bin = (x >> binSize).toString(2);
  return bin === "0" || bin === "-1";
}
function getBinSize(max) {
  return BigInt(Math.floor(Math.log2(Number(max)))) + 3n;
}
var Matrix = class _Matrix {
  field;
  data;
  constructor(field, data) {
    this.field = field;
    const nrows = data.length;
    const ncols = data[0].length;
    for (let i = 1; i < nrows; ++i) {
      if (data[i].length !== ncols) {
        throw Error("All rows must have same number of columns.");
      }
    }
    this.data = data.map((row) => row.map((c) => field.create(c)));
  }
  /**
   * Matrix multiplication between `this` and `rhs`.
   */
  matMul(rhs) {
    const thisNrows = this.data.length;
    const thisNcols = this.data[0].length;
    const rhsNrows = rhs.data.length;
    const rhsNcols = rhs.data[0].length;
    if (thisNcols !== rhsNrows) {
      throw Error(`this.ncols must be equal to rhs.nrows (found ${thisNcols} and ${rhsNrows})`);
    }
    const data = [];
    for (let i = 0; i < thisNrows; ++i) {
      const row = [];
      for (let j = 0; j < rhsNcols; ++j) {
        let c = this.field.ZERO;
        for (let k = 0; k < thisNcols; ++k) {
          c = this.field.add(c, this.field.mul(this.data[i][k], rhs.data[k][j]));
        }
        row.push(c);
      }
      data.push(row);
    }
    return new _Matrix(this.field, data);
  }
  /**
   * Element-wise addition between `this` and `rhs`.
   */
  add(rhs, ct = false) {
    const thisNrows = this.data.length;
    const thisNcols = this.data[0].length;
    const rhsNrows = rhs.data.length;
    const rhsNcols = rhs.data[0].length;
    if (thisNrows !== rhsNrows) {
      throw Error(`this.nrows must be equal to rhs.nrows (found ${thisNrows} and ${rhsNrows})`);
    }
    if (thisNcols !== rhsNcols) {
      throw Error(`this.ncols must be equal to rhs.ncols (found ${thisNcols} and ${rhsNcols})`);
    }
    const binSize = getBinSize(this.field.ORDER - 1n);
    const data = [];
    for (let i = 0; i < thisNrows; ++i) {
      const row = [];
      for (let j = 0; j < thisNcols; ++j) {
        if (ct) {
          const sum = ctAdd(this.data[i][j], rhs.data[i][j], binSize);
          row.push(ctSelect(ctLt(sum, this.field.ORDER, binSize), sum, ctSub(sum, this.field.ORDER, binSize), binSize));
        } else {
          row.push(this.field.add(this.data[i][j], rhs.data[i][j]));
        }
      }
      data.push(row);
    }
    return new _Matrix(this.field, data);
  }
  /**
   * Element-wise subtraction between `this` and `rhs`.
   */
  sub(rhs, ct = false) {
    const thisNrows = this.data.length;
    const thisNcols = this.data[0].length;
    const rhsNrows = rhs.data.length;
    const rhsNcols = rhs.data[0].length;
    if (thisNrows !== rhsNrows) {
      throw Error(`this.nrows must be equal to rhs.nrows (found ${thisNrows} and ${rhsNrows})`);
    }
    if (thisNcols !== rhsNcols) {
      throw Error(`this.ncols must be equal to rhs.ncols (found ${thisNcols} and ${rhsNcols})`);
    }
    const binSize = getBinSize(this.field.ORDER - 1n);
    const data = [];
    for (let i = 0; i < thisNrows; ++i) {
      const row = [];
      for (let j = 0; j < thisNcols; ++j) {
        if (ct) {
          const diff = ctSub(this.data[i][j], rhs.data[i][j], binSize);
          row.push(ctSelect(ctSignBit(diff, binSize), ctAdd(diff, this.field.ORDER, binSize), diff, binSize));
        } else {
          row.push(this.field.sub(this.data[i][j], rhs.data[i][j]));
        }
      }
      data.push(row);
    }
    return new _Matrix(this.field, data);
  }
  /**
   * Raises each element of `this` to the power `e`.
   */
  pow(e) {
    const data = [];
    for (let i = 0; i < this.data.length; ++i) {
      const row = [];
      for (let j = 0; j < this.data[0].length; ++j) {
        row.push(this.field.pow(this.data[i][j], e));
      }
      data.push(row);
    }
    return new _Matrix(this.field, data);
  }
  /**
   * Compute the determinant using Gauss elimination.
   * Match the determinant implementation in Arcis.
   */
  det() {
    const n = this.data.length;
    if (n === 0 || !this.is_square()) {
      throw Error("Matrix must be square and non-empty to compute the determinant.");
    }
    let det = this.field.ONE;
    let rows = this.data.map((row) => [...row]);
    for (let i = 0; i < n; ++i) {
      const lzRows = rows.filter((r) => this.field.is0(r[0]));
      const nlzRows = rows.filter((r) => !this.field.is0(r[0]));
      const pivotRow = nlzRows.shift();
      if (pivotRow === void 0) {
        return this.field.ZERO;
      }
      const pivot = pivotRow[0];
      det = this.field.mul(det, pivot);
      const pivotInverse = this.field.inv(pivot);
      const normalizedPivotRow = pivotRow.map((v) => this.field.mul(pivotInverse, v));
      const nlzRowsProcessed = nlzRows.map((row) => {
        const lead = row[0];
        return row.map((value, index) => this.field.sub(value, this.field.mul(lead, normalizedPivotRow[index])));
      });
      rows = nlzRowsProcessed.concat(lzRows).map((row) => row.slice(1));
    }
    return det;
  }
  is_square() {
    const n = this.data.length;
    for (let i = 1; i < n; ++i) {
      if (this.data[i].length !== n) {
        return false;
      }
    }
    return true;
  }
};
var CURVE25519_BASE_FIELD = import_ed25519.ed25519.Point.Fp;
var CURVE25519_SCALAR_FIELD = import_ed25519.ed25519.Point.Fn;
var SECURITY_LEVEL_BLOCK_CIPHER = 128;
var SECURITY_LEVEL_HASH_FUNCTION = 256;
var RescueDesc = class {
  mode;
  field;
  // The smallest prime that does not divide p-1.
  alpha;
  // The inverse of alpha modulo p-1.
  alphaInverse;
  nRounds;
  m;
  // A Maximum Distance Separable matrix.
  mdsMat;
  // Its inverse.
  mdsMatInverse;
  // The round keys, needed for encryption and decryption.
  roundKeys;
  /**
   * Construct a RescueDesc for a given field and mode (cipher or hash).
   * Initialize round constants, MDS matrix, and key schedule.
   * @param field - Field to use (e.g., CURVE25519_BASE_FIELD).
   * @param mode - Mode: block cipher or hash function.
   */
  constructor(field, mode) {
    this.field = field;
    this.mode = mode;
    switch (this.mode.kind) {
      case "cipher": {
        this.m = this.mode.key.length;
        if (this.m < 2) {
          throw Error(`parameter m must be at least 2 (found ${this.m})`);
        }
        break;
      }
      case "hash": {
        this.m = this.mode.m;
        break;
      }
      default: {
        this.m = 0;
        break;
      }
    }
    const alphaAndInverse = getAlphaAndInverse(this.field.ORDER);
    this.alpha = alphaAndInverse[0];
    this.alphaInverse = alphaAndInverse[1];
    this.nRounds = getNRounds(this.field.ORDER, this.mode, this.alpha, this.m);
    const mdsMatrixAndInverse = getMdsMatrixAndInverse(this.field, this.m);
    this.mdsMat = mdsMatrixAndInverse[0];
    this.mdsMatInverse = mdsMatrixAndInverse[1];
    const roundConstants = this.sampleConstants(this.nRounds);
    switch (this.mode.kind) {
      case "cipher": {
        this.roundKeys = rescuePermutation(this.mode, this.alpha, this.alphaInverse, this.mdsMat, roundConstants, new Matrix(this.field, toVec(this.mode.key)));
        break;
      }
      case "hash": {
        this.roundKeys = roundConstants;
        break;
      }
      default: {
        this.roundKeys = [];
        break;
      }
    }
  }
  /**
   * Sample round constants for the Rescue permutation, using SHAKE256.
   * @param nRounds - Number of rounds.
   * @returns Array of round constant matrices.
   */
  sampleConstants(nRounds) {
    const field = this.field;
    const m = this.m;
    const hasher = import_sha3.shake256.create({ dkLen: 256 / 8 });
    const bufferLen = Math.ceil(field.BITS / 8) + 16;
    switch (this.mode.kind) {
      case "cipher": {
        hasher.update("encrypt everything, compute anything");
        const rFieldArray = Array.from({ length: m * m + 2 * m }, () => {
          const randomness = hasher.xof(bufferLen);
          return field.create(deserializeLE(randomness));
        });
        const matData = Array.from({ length: m }, () => rFieldArray.splice(0, m));
        let roundConstantMat = new Matrix(field, matData);
        const initData = Array.from({ length: m }, () => rFieldArray.splice(0, 1));
        const initialRoundConstant = new Matrix(field, initData);
        const roundData = Array.from({ length: m }, () => rFieldArray.splice(0, 1));
        const roundConstantAffineTerm = new Matrix(field, roundData);
        while (field.is0(roundConstantMat.det())) {
          const resampleArray = Array.from({ length: m * m }, () => {
            const randomness = hasher.xof(bufferLen);
            return field.create(deserializeLE(randomness));
          });
          const resampleData = Array.from({ length: m }, () => resampleArray.splice(0, m));
          roundConstantMat = new Matrix(field, resampleData);
        }
        const roundConstants = [initialRoundConstant];
        for (let r = 0; r < 2 * this.nRounds; ++r) {
          roundConstants.push(roundConstantMat.matMul(roundConstants[r]).add(roundConstantAffineTerm));
        }
        return roundConstants;
      }
      case "hash": {
        hasher.update(`Rescue-XLIX(${this.field.ORDER},${m},${this.mode.capacity},${SECURITY_LEVEL_HASH_FUNCTION})`);
        const zeros = [];
        for (let i = 0; i < m; ++i) {
          zeros.push([0n]);
        }
        const roundConstants = [new Matrix(field, zeros)];
        const rFieldArray = Array.from({ length: 2 * m * nRounds }, () => {
          const randomness = hasher.xof(bufferLen);
          return field.create(deserializeLE(randomness));
        });
        for (let r = 0; r < 2 * nRounds; ++r) {
          const data = [];
          for (let i = 0; i < m; ++i) {
            data.push([rFieldArray[r * m + i]]);
          }
          roundConstants.push(new Matrix(field, data));
        }
        return roundConstants;
      }
      default:
        return [];
    }
  }
  /**
   * Apply the Rescue permutation to a state matrix.
   * @param state - Input state matrix.
   * @returns Permuted state matrix.
   */
  permute(state) {
    return rescuePermutation(this.mode, this.alpha, this.alphaInverse, this.mdsMat, this.roundKeys, state)[2 * this.nRounds];
  }
  /**
   * Apply the inverse Rescue permutation to a state matrix.
   * @param state - Input state matrix.
   * @returns Inverse-permuted state matrix.
   */
  permuteInverse(state) {
    return rescuePermutationInverse(this.mode, this.alpha, this.alphaInverse, this.mdsMatInverse, this.roundKeys, state)[2 * this.nRounds];
  }
};
function getAlphaAndInverse(p) {
  const pMinusOne = p - 1n;
  let alpha = 0n;
  for (const a of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n]) {
    if (pMinusOne % a !== 0n) {
      alpha = a;
      break;
    }
  }
  if (alpha === 0n) {
    throw Error("Could not find prime alpha that does not divide p-1.");
  }
  const alphaInverse = (0, import_modular.invert)(alpha, pMinusOne);
  return [alpha, alphaInverse];
}
function getNRounds(p, mode, alpha, m) {
  function dcon(n) {
    return Math.floor(0.5 * (Number(alpha) - 1) * m * (n - 1) + 2);
  }
  function v(n, rate) {
    return m * (n - 1) + rate;
  }
  function binomial(n, k) {
    function factorial(x) {
      if (x === 0n || x === 1n) {
        return 1n;
      }
      return x * factorial(x - 1n);
    }
    return factorial(BigInt(n)) / (factorial(BigInt(n - k)) * factorial(BigInt(k)));
  }
  switch (mode.kind) {
    case "cipher": {
      const l0 = Math.ceil(2 * SECURITY_LEVEL_BLOCK_CIPHER / ((m + 1) * (Math.log2(Number(p)) - Math.log2(Number(alpha) - 1))));
      let l1 = 0;
      if (alpha === 3n) {
        l1 = Math.ceil((SECURITY_LEVEL_BLOCK_CIPHER + 2) / (4 * m));
      } else {
        l1 = Math.ceil((SECURITY_LEVEL_BLOCK_CIPHER + 3) / (5.5 * m));
      }
      return 2 * Math.max(l0, l1, 5);
    }
    case "hash": {
      const rate = m - mode.capacity;
      const target = 1n << BigInt(SECURITY_LEVEL_HASH_FUNCTION);
      let l1 = 1;
      let tmp = binomial(v(l1, rate) + dcon(l1), v(l1, rate));
      while (tmp * tmp <= target && l1 <= 23) {
        l1 += 1;
        tmp = binomial(v(l1, rate) + dcon(l1), v(l1, rate));
      }
      return Math.ceil(1.5 * Math.max(5, l1));
    }
    default:
      return 0;
  }
}
function buildCauchy(field, size) {
  const data = [];
  for (let i = 1n; i <= size; ++i) {
    const row = [];
    for (let j = 1n; j <= size; ++j) {
      row.push(field.inv(i + j));
    }
    data.push(row);
  }
  return new Matrix(field, data);
}
function buildInverseCauchy(field, size) {
  function product(arr) {
    return arr.reduce((acc, curr) => field.mul(acc, field.create(curr)), field.ONE);
  }
  function prime(arr, val) {
    return product(arr.map((u) => {
      if (u !== val) {
        return val - u;
      }
      return 1n;
    }));
  }
  const data = [];
  for (let i = 1n; i <= size; ++i) {
    const row = [];
    for (let j = 1n; j <= size; ++j) {
      const a = product(Array.from({ length: size }, (_, key) => -i - BigInt(1 + key)));
      const aPrime = prime(Array.from({ length: size }, (_, key) => BigInt(1 + key)), j);
      const b = product(Array.from({ length: size }, (_, key) => j + BigInt(1 + key)));
      const bPrime = prime(Array.from({ length: size }, (_, key) => -BigInt(1 + key)), -i);
      row.push(field.mul(a, field.mul(b, field.mul(field.inv(aPrime), field.mul(field.inv(bPrime), field.inv(-i - j))))));
    }
    data.push(row);
  }
  return new Matrix(field, data);
}
function getMdsMatrixAndInverse(field, m) {
  const mdsMat = buildCauchy(field, m);
  const mdsMatInverse = buildInverseCauchy(field, m);
  return [mdsMat, mdsMatInverse];
}
function exponentForEven(mode, alpha, alphaInverse) {
  switch (mode.kind) {
    case "cipher": {
      return alphaInverse;
    }
    case "hash": {
      return alpha;
    }
    default:
      return 0n;
  }
}
function exponentForOdd(mode, alpha, alphaInverse) {
  switch (mode.kind) {
    case "cipher": {
      return alpha;
    }
    case "hash": {
      return alphaInverse;
    }
    default:
      return 0n;
  }
}
function rescuePermutation(mode, alpha, alphaInverse, mdsMat, subkeys, state) {
  const exponentEven = exponentForEven(mode, alpha, alphaInverse);
  const exponentOdd = exponentForOdd(mode, alpha, alphaInverse);
  const states = [state.add(subkeys[0])];
  for (let r = 0; r < subkeys.length - 1; ++r) {
    let s = states[r];
    if (r % 2 === 0) {
      s = s.pow(exponentEven);
    } else {
      s = s.pow(exponentOdd);
    }
    states.push(mdsMat.matMul(s).add(subkeys[r + 1]));
  }
  return states;
}
function rescuePermutationInverse(mode, alpha, alphaInverse, mdsMatInverse, subkeys, state) {
  const exponentEven = exponentForEven(mode, alpha, alphaInverse);
  const exponentOdd = exponentForOdd(mode, alpha, alphaInverse);
  const states = [state];
  for (let r = 0; r < subkeys.length - 1; ++r) {
    let s = states[r];
    s = mdsMatInverse.matMul(s.sub(subkeys[subkeys.length - 1 - r]));
    if (r % 2 === 0) {
      s = s.pow(exponentEven);
    } else {
      s = s.pow(exponentOdd);
    }
    states.push(s);
  }
  states.push(states[states.length - 1].sub(subkeys[0]));
  states.shift();
  return states;
}
function toVec(data) {
  const dataVec = [];
  for (let i = 0; i < data.length; ++i) {
    dataVec.push([data[i]]);
  }
  return dataVec;
}
var RescuePrimeHash = class {
  desc;
  rate;
  digestLength;
  /**
   * Construct a RescuePrimeHash instance with rate = 7 and capacity = 5.
   */
  constructor(field) {
    this.desc = new RescueDesc(field, { kind: "hash", m: 12, capacity: 5 });
    this.rate = 7;
    this.digestLength = 5;
  }
  // This is Algorithm 1 from https://eprint.iacr.org/2020/1143.pdf, though with the padding (see Algorithm 2).
  // The hash is truncated to digestLength elements.
  // According to Section 2.2, this offers min(log2(CURVE25519_BASE_FIELD.ORDER) / 2 * min(digestLength, capacity), s)
  // bits of security against collision, preimage and second-preimage attacks.
  // The security level is thus of the order of 256 bits for any field of size at least 102 bits.
  // The rate and capacity are chosen to achieve minimal number of rounds 8.
  /**
   * Compute the Rescue-Prime hash of a message, with padding as described in Algorithm 2 of the paper.
   * @param message - Input message as an array of bigints.
   * @returns Hash output as an array of bigints (length = digestLength).
   */
  digest(message) {
    const paddedMessage = [...message, 1n];
    while (paddedMessage.length % this.rate !== 0) {
      paddedMessage.push(0n);
    }
    const zeros = [];
    for (let i = 0; i < this.desc.m; ++i) {
      zeros.push([0n]);
    }
    let state = new Matrix(this.desc.field, zeros);
    for (let r = 0; r < paddedMessage.length / this.rate; ++r) {
      const data = [];
      for (let i = 0; i < this.rate; ++i) {
        data[i] = [paddedMessage[r * this.rate + i]];
      }
      for (let i = this.rate; i < this.desc.m; ++i) {
        data[i] = [0n];
      }
      const s = new Matrix(this.desc.field, data);
      state = this.desc.permute(state.add(s, true));
    }
    const res = [];
    for (let i = 0; i < this.digestLength; ++i) {
      res.push(state.data[i][0]);
    }
    return res;
  }
};
var RESCUE_CIPHER_BLOCK_SIZE = 5;
var RescueCipherCommon = class {
  desc;
  /**
   * Construct a RescueCipherCommon instance using a shared secret.
   * The key is derived using RescuePrimeHash and used to initialize the RescueDesc.
   * @param sharedSecret - Shared secret to derive the cipher key from.
   */
  constructor(sharedSecret, field) {
    if (sharedSecret.length != 32) {
      throw Error(`sharedSecret must be of length 32 (found ${sharedSecret.length})`);
    }
    const hasher = new RescuePrimeHash(field);
    const converted = [];
    if (field === CURVE25519_BASE_FIELD) {
      converted.push(deserializeLE(sharedSecret));
    } else {
      const chunkSize = field.BYTES - 1;
      const nChunks = Math.ceil(sharedSecret.length / chunkSize);
      for (let i = 0; i < nChunks; ++i) {
        converted.push(deserializeLE(sharedSecret.slice(i * chunkSize, (i + 1) * chunkSize)));
      }
    }
    const counter = [1n, ...converted, BigInt(RESCUE_CIPHER_BLOCK_SIZE)];
    const rescueKey = hasher.digest(counter);
    this.desc = new RescueDesc(field, { kind: "cipher", key: rescueKey });
  }
  /**
   * Encrypt the plaintext vector in Counter (CTR) mode (raw, returns bigints).
   * @param plaintext - Array of plaintext bigints to encrypt.
   * @param nonce - 16-byte nonce for CTR mode.
   * @returns Ciphertext as an array of bigints.
   * @throws Error if the nonce is not 16 bytes long.
   */
  encrypt_raw(plaintext, nonce) {
    if (nonce.length !== 16) {
      throw Error(`nonce must be of length 16 (found ${nonce.length})`);
    }
    const binSize = getBinSize(this.desc.field.ORDER - 1n);
    function encryptBatch(desc, ptxt, cntr) {
      if (cntr.length !== RESCUE_CIPHER_BLOCK_SIZE) {
        throw Error(`counter must be of length ${RESCUE_CIPHER_BLOCK_SIZE} (found ${cntr.length})`);
      }
      const encryptedCounter = desc.permute(new Matrix(desc.field, toVec(cntr)));
      const ciphertext2 = [];
      for (let i = 0; i < ptxt.length; ++i) {
        if (!verifyBinSize(ptxt[i], binSize - 1n) || ctSignBit(ptxt[i], binSize) || !ctLt(ptxt[i], desc.field.ORDER, binSize)) {
          throw Error(`plaintext must be non-negative and less than ${desc.field.ORDER}`);
        }
        const sum = ctAdd(ptxt[i], encryptedCounter.data[i][0], binSize);
        ciphertext2.push(ctSelect(ctLt(sum, desc.field.ORDER, binSize), sum, ctSub(sum, desc.field.ORDER, binSize), binSize));
      }
      return ciphertext2;
    }
    const nBlocks = Math.ceil(plaintext.length / RESCUE_CIPHER_BLOCK_SIZE);
    const counter = getCounter(deserializeLE(nonce), nBlocks);
    const ciphertext = [];
    for (let i = 0; i < nBlocks; ++i) {
      const cnt = RESCUE_CIPHER_BLOCK_SIZE * i;
      const newCiphertext = encryptBatch(this.desc, plaintext.slice(cnt, Math.min(cnt + RESCUE_CIPHER_BLOCK_SIZE, plaintext.length)), counter.slice(cnt, cnt + RESCUE_CIPHER_BLOCK_SIZE));
      for (let j = 0; j < newCiphertext.length; ++j) {
        ciphertext.push(newCiphertext[j]);
      }
    }
    return ciphertext;
  }
  /**
   * Encrypt the plaintext vector in Counter (CTR) mode and serialize each block.
   * @param plaintext - Array of plaintext bigints to encrypt.
   * @param nonce - 16-byte nonce for CTR mode.
   * @returns Ciphertext as an array of arrays of numbers (each 32 bytes).
   */
  encrypt(plaintext, nonce) {
    return this.encrypt_raw(plaintext, nonce).map((c) => Array.from(serializeLE(c, 32)));
  }
  /**
   * Decrypt the ciphertext vector in Counter (CTR) mode (raw, expects bigints).
   * @param ciphertext - Array of ciphertext bigints to decrypt.
   * @param nonce - 16-byte nonce for CTR mode.
   * @returns Decrypted plaintext as an array of bigints.
   * @throws Error if the nonce is not 16 bytes long.
   */
  decrypt_raw(ciphertext, nonce) {
    if (nonce.length !== 16) {
      throw Error(`nonce must be of length 16 (found ${nonce.length})`);
    }
    const binSize = getBinSize(this.desc.field.ORDER - 1n);
    function decryptBatch(desc, ctxt, cntr) {
      if (cntr.length !== RESCUE_CIPHER_BLOCK_SIZE) {
        throw Error(`counter must be of length ${RESCUE_CIPHER_BLOCK_SIZE} (found ${cntr.length})`);
      }
      const encryptedCounter = desc.permute(new Matrix(desc.field, toVec(cntr)));
      const decrypted2 = [];
      for (let i = 0; i < ctxt.length; ++i) {
        const diff = ctSub(ctxt[i], encryptedCounter.data[i][0], binSize);
        decrypted2.push(ctSelect(ctSignBit(diff, binSize), ctAdd(diff, desc.field.ORDER, binSize), diff, binSize));
      }
      return decrypted2;
    }
    const nBlocks = Math.ceil(ciphertext.length / RESCUE_CIPHER_BLOCK_SIZE);
    const counter = getCounter(deserializeLE(nonce), nBlocks);
    const decrypted = [];
    for (let i = 0; i < nBlocks; ++i) {
      const cnt = RESCUE_CIPHER_BLOCK_SIZE * i;
      const newDecrypted = decryptBatch(this.desc, ciphertext.slice(cnt, Math.min(cnt + RESCUE_CIPHER_BLOCK_SIZE, ciphertext.length)), counter.slice(cnt, cnt + RESCUE_CIPHER_BLOCK_SIZE));
      for (let j = 0; j < newDecrypted.length; ++j) {
        decrypted.push(newDecrypted[j]);
      }
    }
    return decrypted;
  }
  /**
   * Deserialize and decrypt the ciphertext vector in Counter (CTR) mode.
   * @param ciphertext - Array of arrays of numbers (each 32 bytes) to decrypt.
   * @param nonce - 16-byte nonce for CTR mode.
   * @returns Decrypted plaintext as an array of bigints.
   */
  decrypt(ciphertext, nonce) {
    return this.decrypt_raw(ciphertext.map((c) => {
      if (c.length !== 32) {
        throw Error(`ciphertext must be of length 32 (found ${c.length})`);
      }
      return deserializeLE(Uint8Array.from(c));
    }), nonce);
  }
};
function getCounter(nonce, nBlocks) {
  const counter = [];
  for (let i = 0n; i < nBlocks; ++i) {
    counter.push(nonce);
    counter.push(i);
    for (let j = 2; j < RESCUE_CIPHER_BLOCK_SIZE; ++j) {
      counter.push(0n);
    }
  }
  return counter;
}
var RescueCipher = class {
  cipher;
  /**
   * Construct a RescueCipher instance using a shared secret.
   * The key is derived using RescuePrimeHash and used to initialize the RescueDesc.
   * @param sharedSecret - Shared secret to derive the cipher key from.
   */
  constructor(sharedSecret) {
    this.cipher = new RescueCipherCommon(sharedSecret, CURVE25519_BASE_FIELD);
  }
  /**
   * Encrypt the plaintext vector in Counter (CTR) mode and serialize each block.
   * @param plaintext - Array of plaintext bigints to encrypt.
   * @param nonce - 16-byte nonce for CTR mode.
   * @returns Ciphertext as an array of arrays of numbers (each 32 bytes).
   */
  encrypt(plaintext, nonce) {
    return this.cipher.encrypt(plaintext, nonce);
  }
  /**
   * Deserialize and decrypt the ciphertext vector in Counter (CTR) mode.
   * @param ciphertext - Array of arrays of numbers (each 32 bytes) to decrypt.
   * @param nonce - 16-byte nonce for CTR mode.
   * @returns Decrypted plaintext as an array of bigints.
   */
  decrypt(ciphertext, nonce) {
    return this.cipher.decrypt(ciphertext, nonce);
  }
};
export {
  RescueCipher
};
/*! Bundled license information:

@noble/hashes/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/utils.js:
@noble/curves/abstract/modular.js:
@noble/curves/abstract/curve.js:
@noble/curves/abstract/edwards.js:
@noble/curves/abstract/montgomery.js:
@noble/curves/ed25519.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
