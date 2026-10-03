/*
 * Nex — MP4 Patcher
 * Editing News
 */
/*
 * variant_a_clean.js
 * Duration-spoof patcher: marca la duracion del mvhd como "desconocida"
 * (0xFF...FF, forzando version=1) e inyecta un tag de encoder falso en
 * udta/meta/ilst/(c)too. Si el moov crece y esta antes del mdat, reajusta
 * los offsets stco/co64 de todas las pistas.
 */
(() => {
  "use strict";

  const UNKNOWN_DURATION = new Uint8Array(8).fill(0xff);
  const ENCODER_TAG = "TAY";
  const CONTAINER_TYPES = new Set([
    "moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "meta", "ilst"
  ]);

  const fail = (msg) => { throw new Error(msg); };
  const toU8 = (x) => x instanceof Uint8Array ? x : new Uint8Array(x);
  const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const readU32 = (b, o) => view(b).getUint32(o, false);
  const readU64 = (b, o) => view(b).getBigUint64(o, false);
  const u32 = (v) => { const o = new Uint8Array(4); view(o).setUint32(0, Number(v) >>> 0, false); return o; };
  const u64 = (v) => { const o = new Uint8Array(8); view(o).setBigUint64(0, BigInt(v), false); return o; };
  const str4 = (s) => Uint8Array.from([0,1,2,3].map(i => s.charCodeAt(i) & 0xff));
  const concat = (parts) => {
    const list = parts.filter(Boolean);
    const out = new Uint8Array(list.reduce((n, p) => n + p.length, 0));
    let p = 0;
    for (const part of list) { out.set(part, p); p += part.length; }
    return out;
  };
  const typeAt = (b, o) => String.fromCharCode(b[o], b[o+1], b[o+2], b[o+3]);

  class Box {
    constructor(type, payload = null, children = null, prefix = null) {
      this.type = type;
      this.payload = payload || new Uint8Array(0);
      this.children = children;
      this.prefix = prefix || new Uint8Array(0);
      this.start = 0; this.end = 0; this.size = 0; this.header = 8;
    }
    find(type) { return this.children ? (this.children.find(c => c.type === type) || null) : null; }
    findAll(type) { return this.children ? this.children.filter(c => c.type === type) : []; }
    findDeep(...types) { let n = this; for (const t of types) n = n && n.find(t); return n || null; }
    serialize() {
      const payload = this.children
        ? concat([this.prefix, ...this.children.map(c => c.serialize())])
        : this.payload;
      const size = payload.length + 8;
      return size <= 0xffffffff
        ? concat([u32(size), str4(this.type), payload])
        : concat([u32(1), str4(this.type), u64(payload.length + 16), payload]);
    }
  }

  function parseChildren(bytes, start, end) {
    const boxes = [];
    let offset = start;
    while (offset + 8 <= end) {
      const size32 = readU32(bytes, offset);
      const type = typeAt(bytes, offset + 4);
      let header = 8, size;
      if (size32 === 1) {
        if (offset + 16 > end) break;
        const size64 = readU64(bytes, offset + 8);
        if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) fail(`Box ${type} too large.`);
        size = Number(size64); header = 16;
      } else if (size32 === 0) {
        size = end - offset;
      } else {
        size = size32;
      }
      if (!Number.isSafeInteger(size) || size < header || offset + size > end) break;

      const payloadStart = offset + header, payloadEnd = offset + size;
      const childStart = payloadStart + (type === "meta" ? 4 : 0);
      const isContainer = CONTAINER_TYPES.has(type);
      const children = isContainer && childStart <= payloadEnd ? parseChildren(bytes, childStart, payloadEnd) : null;
      const prefix = children ? bytes.slice(payloadStart, childStart) : null;
      const payload = children ? null : bytes.slice(payloadStart, payloadEnd);

      const box = new Box(type, payload, children, prefix);
      box.start = offset; box.end = payloadEnd; box.size = size; box.header = header;
      box.payloadStart = payloadStart; box.payloadEnd = payloadEnd;
      if (children) { box._src = bytes; }

      boxes.push(box);
      offset += size;
    }
    return boxes;
  }

  const getPayload = (box) => box.payload && box.payload.length ? box.payload
    : (box._src ? box._src.subarray(box.payloadStart, box.payloadEnd) : new Uint8Array(0));

  function cloneTree(box) {
    if (!box) return null;
    return box.children
      ? new Box(box.type, null, box.children.map(cloneTree), box.prefix.slice())
      : new Box(box.type, getPayload(box).slice(), null);
  }

  function isUnknownDuration(payload) {
    if (!payload || payload.length < 32 || payload[0] !== 1) return false;
    for (let i = 0; i < 8; i++) if (payload[24 + i] !== 0xff) return false;
    return true;
  }

  function patchMvhd(payload) {
    if (!payload || payload.length < 4) fail("Invalid mvhd.");
    const version = payload[0];
    if (version === 1) {
      if (payload.length < 112) fail("Invalid mvhd-1.");
      const out = payload.slice();
      out.set(UNKNOWN_DURATION, 24);
      return out;
    }
    if (version !== 0) fail("Unsupported mvhd version.");
    if (payload.length < 100) fail("Invalid mvhd-0.");
    // version 0 -> 1 para poder usar el marcador de 8 bytes
    return concat([
      Uint8Array.from([1, payload[1], payload[2], payload[3]]),
      u32(0), payload.slice(4, 8),
      u32(0), payload.slice(8, 12),
      payload.slice(12, 16),
      UNKNOWN_DURATION.slice(),
      payload.slice(20, 100),
    ]);
  }

  const strN = (s) => Uint8Array.from(s.split("").map(c => c.charCodeAt(0) & 0xff));

  function injectEncoderTag(moov, tag = ENCODER_TAG) {
    const encoderBox = () => new Box("\xa9too", concat([u32(1), u32(0), strN(tag)]));

    let udta = moov.find("udta");
    if (!udta) {
      udta = new Box("udta", null, [new Box("meta", null, [new Box("ilst", null, [encoderBox()])])]);
      moov.children.push(udta);
      return;
    }
    let meta = udta.find("meta");
    if (!meta) {
      meta = new Box("meta", null, [new Box("ilst", null, [encoderBox()])]);
      udta.children.push(meta);
      return;
    }
    let ilst = meta.find("ilst");
    if (!ilst) {
      ilst = new Box("ilst", null, [encoderBox()]);
      meta.children.push(ilst);
      return;
    }
    const kept = ilst.children.filter(c => c.type !== "\xa9too");
    ilst.children = [...kept, encoderBox()];
  }

  function findOffsetsBox(trak) {
    const stbl = trak.findDeep("mdia", "minf", "stbl");
    return stbl && (stbl.find("stco") || stbl.find("co64"));
  }

  function readOffsets(box) {
    const payload = getPayload(box);
    const count = readU32(payload, 4);
    const wide = box.type === "co64";
    const step = wide ? 8 : 4;
    const out = new Array(count);
    for (let i = 0, p = 8; i < count; i++, p += step) {
      out[i] = Number(wide ? readU64(payload, p) : BigInt(readU32(payload, p)));
    }
    return out;
  }

  function writeOffsets(box, offsets) {
    const use64 = box.type === "co64" || offsets.some(v => v > 0xffffffff);
    const payload = new Uint8Array(8 + offsets.length * (use64 ? 8 : 4));
    view(payload).setUint32(4, offsets.length >>> 0, false);
    let p = 8;
    for (const off of offsets) {
      if (use64) { view(payload).setBigUint64(p, BigInt(off), false); p += 8; }
      else { view(payload).setUint32(p, off >>> 0, false); p += 4; }
    }
    return new Box(use64 ? "co64" : "stco", payload);
  }

  function shiftAllOffsets(moov, delta) {
    for (const trak of moov.findAll("trak")) {
      const box = findOffsetsBox(trak);
      if (!box) continue;
      const shifted = readOffsets(box).map(v => v + delta);
      const replacement = writeOffsets(box, shifted);
      trak.children = trak.children.map(c => replaceDeep(c, box, replacement));
    }
  }

  function replaceDeep(node, target, replacement) {
    if (node === target) return replacement;
    if (!node.children) return node;
    node.children = node.children.map(c => replaceDeep(c, target, replacement));
    return node;
  }

  function parseFile(bytes) {
    const source = toU8(bytes);
    const top = parseChildren(source, 0, source.length);
    const ftyp = top.filter(b => b.type === "ftyp");
    const moovs = top.filter(b => b.type === "moov");
    const mdats = top.filter(b => b.type === "mdat");
    if (ftyp.length !== 1 || moovs.length !== 1 || mdats.length !== 1) fail("Invalid MP4.");
    if (top.some(b => b.type === "moof")) fail("Fragmented MP4 not supported.");

    const moovBox = moovs[0], mdatBox = mdats[0];
    const mvhd = moovBox.find("mvhd");
    if (!mvhd) fail("Missing mvhd.");
    if (isUnknownDuration(getPayload(mvhd))) fail("Already patched.");

    return { source, top, ftypBox: ftyp[0], moovBox, mdatBox };
  }

  function applyPatch(sourceBytes, info) {
    const source = toU8(sourceBytes);
    const moov = cloneTree(info.moovBox);

    const mvhd = moov.find("mvhd");
    mvhd.payload = patchMvhd(getPayload(mvhd));

    // --- 120fps trigger ---
    // Rewrite stts of the video track: merge all entries into a single entry
    // with delta = timescale/120, making the declared framerate 120fps.
    // The actual sample data is untouched -- only the timing table changes.
    for (const trak of moov.findAll("trak")) {
      const hdlr = trak.findDeep("mdia", "hdlr");
      if (!hdlr) continue;
      const hp = getPayload(hdlr);
      const handler = String.fromCharCode(hp[8], hp[9], hp[10], hp[11]);
      if (handler !== "vide") continue;

      const mdhd = trak.findDeep("mdia", "mdhd");
      if (!mdhd) continue;
      const mp = getPayload(mdhd);
      const version = mp[0];
      const timescale = readU32(mp, version === 1 ? 24 : 12);
      const delta120  = Math.round(timescale / 120); // e.g. 19200/120 = 160

      const stbl = trak.findDeep("mdia", "minf", "stbl");
      if (!stbl) continue;
      const stts = stbl && stbl.find("stts");
      if (!stts) continue;

      const sp = getPayload(stts);
      const count = readU32(sp, 4);
      // Sum total samples across all entries
      let totalSamples = 0;
      for (let i = 0, o = 8; i < count; i++, o += 8) {
        totalSamples += readU32(sp, o);
      }

      // Build new stts: 1 entry, all samples at 120fps delta
      const newPayload = new Uint8Array(4 + 4 + 4 + 8); // flags + count(1) + entry
      view(newPayload).setUint32(0, 0, false);     // version+flags
      view(newPayload).setUint32(4, 1, false);     // entry count = 1
      view(newPayload).setUint32(8, totalSamples, false);  // sample count
      view(newPayload).setUint32(12, delta120, false);     // sample delta
      stts.payload = newPayload;
      stts.children = null;
      break; // only video track
    }

    // --- ©too TAY tag + copyright cleanup ---
    // 1. Inject ©too TAY (replaces any existing encoder tag)
    injectEncoderTag(moov, ENCODER_TAG);

    // 2. Strip ShoreUploader traces: remove udta children with unwanted tags
    //    (©cmt, cprt, ©aut) and replace with TAY copyright
    const udta = moov.find("udta");
    if (udta && udta.children) {
      // Remove ©cmt (Comment: shoreuploader.com) and cprt
      udta.children = udta.children.filter(c =>
        c.type !== "©cmt" && c.type !== "cprt" && c.type !== "©aut"
      );
      // Add TAY copyright box
      const cprtPayload = concat([u32(1), u32(0), strN("TAY")]);
      udta.children.push(new Box("cprt", cprtPayload));
    }

    // 3. Rewrite Encoded_Application tag (©too already handled by injectEncoderTag)

    const oldSize = info.moovBox.size;
    const moovBeforeMdat = info.moovBox.start < info.mdatBox.start;

    let serialized = moov.serialize();

    if (moovBeforeMdat) {
      for (let pass = 0; pass < 4; pass++) {
        const delta = serialized.length - oldSize;
        const before = serialized.length;
        shiftAllOffsets(moov, delta);
        serialized = moov.serialize();
        if (serialized.length === before) break;
      }
    }

    const out = [];
    for (const box of info.top) {
      out.push(box === info.moovBox ? serialized : source.subarray(box.start, box.end));
    }
    let result = concat(out);

    // --- Byte-level cleanup: replace third-party metadata strings ---
    function replaceStr(buf, needle, replacement) {
      const enc = typeof needle === 'string'
        ? Uint8Array.from(needle.split('').map(c => c.charCodeAt(0) & 0xff))
        : needle;
      const rep = typeof replacement === 'string'
        ? Uint8Array.from(replacement.split('').map(c => c.charCodeAt(0) & 0xff))
        : replacement;
      let i = 0;
      while (i + enc.length <= buf.length) {
        let match = true;
        for (let j = 0; j < enc.length; j++) if (buf[i + j] !== enc[j]) { match = false; break; }
        if (match) {
          // replace with rep, pad remainder with 0x00
          const end = Math.min(i + enc.length, buf.length);
          for (let j = 0; j < rep.length && i + j < buf.length; j++) buf[i + j] = rep[j];
          for (let j = rep.length; j < enc.length && i + j < buf.length; j++) buf[i + j] = 0x00;
          i += enc.length;
        } else { i++; }
      }
      return buf;
    }

    result = replaceStr(result, 'ShoreUploader-v2.0.3', 'TAY');
    result = replaceStr(result, 'shoreuploader-coded',   'TAY-coded          ');
    result = replaceStr(result, 'shoreuploader.com',     'TAY              ');

    return result;
  }

  function patchVideo(input) {
    const bytes = toU8(input);
    const info = parseFile(bytes);
    return applyPatch(bytes, info);
  }

  const api = { patchVideo, parseFile, applyPatch, isUnknownDuration, ENCODER_TAG };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.DurationSpoofPatcher = api;

  if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
    const fs = require("fs");
    const [inPath, outPath] = process.argv.slice(2);
    if (!inPath || !outPath) {
      console.error("Uso: node " + require("path").basename(__filename) + " input.mp4 output.mp4");
      process.exit(1);
    }
    try {
      const data = fs.readFileSync(inPath);
      const out = patchVideo(new Uint8Array(data));
      fs.writeFileSync(outPath, Buffer.from(out));
      console.log("OK -> " + outPath);
    } catch (e) {
      console.error("ERROR:", e.message || e);
      process.exit(1);
    }
  }
})();
