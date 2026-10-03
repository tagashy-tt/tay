/*
 * Nex — MP4 Patcher
 * 60/120 FPS test version
 *
 * - Keeps mvhd untouched
 * - Preserves approximately 60/120 FPS
 * - Keeps other FPS untouched
 * - Keeps TAY metadata handling
 */

(() => {
  "use strict";

  const ENCODER_TAG = "TAY";

  const CONTAINER_TYPES = new Set([
    "moov", "trak", "mdia", "minf", "stbl",
    "edts", "dinf", "udta", "meta", "ilst"
  ]);

  const fail = (msg) => {
    throw new Error(msg);
  };

  const toU8 = (x) =>
    x instanceof Uint8Array ? x : new Uint8Array(x);

  const view = (b) =>
    new DataView(b.buffer, b.byteOffset, b.byteLength);

  const readU32 = (b, o) =>
    view(b).getUint32(o, false);

  const readU64 = (b, o) =>
    view(b).getBigUint64(o, false);

  const u32 = (v) => {
    const o = new Uint8Array(4);
    view(o).setUint32(0, Number(v) >>> 0, false);
    return o;
  };

  const u64 = (v) => {
    const o = new Uint8Array(8);
    view(o).setBigUint64(0, BigInt(v), false);
    return o;
  };

  const str4 = (s) =>
    Uint8Array.from([0, 1, 2, 3].map(i =>
      s.charCodeAt(i) & 0xff
    ));

  const concat = (parts) => {
    const list = parts.filter(Boolean);

    const out = new Uint8Array(
      list.reduce((n, p) => n + p.length, 0)
    );

    let p = 0;

    for (const part of list) {
      out.set(part, p);
      p += part.length;
    }

    return out;
  };

  const typeAt = (b, o) =>
    String.fromCharCode(
      b[o],
      b[o + 1],
      b[o + 2],
      b[o + 3]
    );


  // ------------------------------------------------------------
  // MP4 BOX
  // ------------------------------------------------------------

  class Box {
    constructor(type, payload = null, children = null, prefix = null) {
      this.type = type;
      this.payload = payload || new Uint8Array(0);
      this.children = children;
      this.prefix = prefix || new Uint8Array(0);

      this.start = 0;
      this.end = 0;
      this.size = 0;
      this.header = 8;
    }

    find(type) {
      return this.children
        ? (this.children.find(c => c.type === type) || null)
        : null;
    }

    findAll(type) {
      return this.children
        ? this.children.filter(c => c.type === type)
        : [];
    }

    findDeep(...types) {
      let n = this;

      for (const t of types) {
        n = n && n.find(t);
      }

      return n || null;
    }

    serialize() {
      const payload = this.children
        ? concat([
            this.prefix,
            ...this.children.map(c => c.serialize())
          ])
        : this.payload;

      const size = payload.length + 8;

      return size <= 0xffffffff
        ? concat([
            u32(size),
            str4(this.type),
            payload
          ])
        : concat([
            u32(1),
            str4(this.type),
            u64(payload.length + 16),
            payload
          ]);
    }
  }


  // ------------------------------------------------------------
  // PARSER
  // ------------------------------------------------------------

  function parseChildren(bytes, start, end) {
    const boxes = [];
    let offset = start;

    while (offset + 8 <= end) {
      const size32 = readU32(bytes, offset);
      const type = typeAt(bytes, offset + 4);

      let header = 8;
      let size;

      if (size32 === 1) {
        if (offset + 16 > end) break;

        const size64 = readU64(bytes, offset + 8);

        if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) {
          fail(`Box ${type} too large.`);
        }

        size = Number(size64);
        header = 16;

      } else if (size32 === 0) {

        size = end - offset;

      } else {

        size = size32;
      }

      if (
        !Number.isSafeInteger(size) ||
        size < header ||
        offset + size > end
      ) {
        break;
      }

      const payloadStart = offset + header;
      const payloadEnd = offset + size;

      const childStart =
        payloadStart + (type === "meta" ? 4 : 0);

      const isContainer =
        CONTAINER_TYPES.has(type);

      const children =
        isContainer && childStart <= payloadEnd
          ? parseChildren(
              bytes,
              childStart,
              payloadEnd
            )
          : null;

      const prefix =
        children
          ? bytes.slice(payloadStart, childStart)
          : null;

      const payload =
        children
          ? null
          : bytes.slice(payloadStart, payloadEnd);

      const box = new Box(
        type,
        payload,
        children,
        prefix
      );

      box.start = offset;
      box.end = payloadEnd;
      box.size = size;
      box.header = header;

      box.payloadStart = payloadStart;
      box.payloadEnd = payloadEnd;

      if (children) {
        box._src = bytes;
      }

      boxes.push(box);

      offset += size;
    }

    return boxes;
  }


  const getPayload = (box) =>
    box.payload && box.payload.length
      ? box.payload
      : (
          box._src
            ? box._src.subarray(
                box.payloadStart,
                box.payloadEnd
              )
            : new Uint8Array(0)
        );


  function cloneTree(box) {
    if (!box) return null;

    return box.children
      ? new Box(
          box.type,
          null,
          box.children.map(cloneTree),
          box.prefix.slice()
        )
      : new Box(
          box.type,
          getPayload(box).slice(),
          null
        );
  }


  // ------------------------------------------------------------
  // METADATA
  // ------------------------------------------------------------

  const strN = (s) =>
    Uint8Array.from(
      s.split("").map(
        c => c.charCodeAt(0) & 0xff
      )
    );


  function injectEncoderTag(
    moov,
    tag = ENCODER_TAG
  ) {

    const encoderBox = () =>
      new Box(
        "\xa9too",
        concat([
          u32(1),
          u32(0),
          strN(tag)
        ])
      );


    let udta = moov.find("udta");

    if (!udta) {

      udta = new Box(
        "udta",
        null,
        [
          new Box(
            "meta",
            null,
            [
              new Box(
                "ilst",
                null,
                [
                  encoderBox()
                ]
              )
            ]
          )
        ]
      );
   moov.children.push(udta);
   return;

    }
    
    let meta = udta.find("meta");

    if (!meta) {
      meta = new Box(
        "meta",
        null,
        [
          new Box(
            "ilst",
            null,
            [
              encoderBox()
            ]
          )
        ]
      );

      udta.children.push(meta);
      return;
    }

    let ilst = meta.find("ilst");

    if (!ilst) {
      ilst = new Box(
        "ilst",
        null,
        [
          encoderBox()
        ]
      );

      meta.children.push(ilst);
      return;
    }

    const old = ilst.find("\xa9too");

    if (old) {
      const index = ilst.children.indexOf(old);
      ilst.children[index] = encoderBox();
    } else {
      ilst.children.push(encoderBox());
    }
  }


  // ------------------------------------------------------------
  // FPS / STTS
  // ------------------------------------------------------------

  function getVideoTrack(moov) {
    if (!moov.children) return null;

    for (const trak of moov.findAll("trak")) {
      const hdlr = trak.findDeep("mdia", "hdlr");

      if (!hdlr) continue;

      const p = getPayload(hdlr);

      if (
        p.length >= 12 &&
        typeAt(p, 8) === "vide"
      ) {
        return trak;
      }
    }

    return null;
  }


  function getMdhdTimescale(trak) {
    const mdhd = trak.findDeep("mdia", "mdhd");

    if (!mdhd) return 0;

    const p = getPayload(mdhd);

    if (p.length < 20) return 0;

    const version = p[0];

    if (version === 1) {
      if (p.length < 32) return 0;
      return readU32(p, 20);
    }

    return readU32(p, 12);
  }


  function readSttsEntries(stts) {
    const p = getPayload(stts);

    if (p.length < 8) return [];

    const entryCount = readU32(p, 4);

    const entries = [];

    let offset = 8;

    for (
      let i = 0;
      i < entryCount && offset + 8 <= p.length;
      i++
    ) {
      const sampleCount = readU32(p, offset);
      const sampleDelta = readU32(p, offset + 4);

      entries.push({
        sampleCount,
        sampleDelta
      });

      offset += 8;
    }

    return entries;
  }


  function getFpsInfo(trak) {
    const stts = trak.findDeep(
      "mdia",
      "minf",
      "stbl",
      "stts"
    );

    if (!stts) return null;

    const timescale = getMdhdTimescale(trak);

    if (!timescale) return null;

    const entries = readSttsEntries(stts);

    if (!entries.length) return null;

    let totalSamples = 0;
    let totalDuration = 0;

    for (const e of entries) {
      totalSamples += e.sampleCount;
      totalDuration +=
        e.sampleCount * e.sampleDelta;
    }

    if (!totalSamples || !totalDuration) {
      return null;
    }

    const fps =
      timescale *
      totalSamples /
      totalDuration;

    return {
      timescale,
      totalSamples,
      totalDuration,
      fps,
      entries
    };
  }


  function patchFps(moov) {
    const trak = getVideoTrack(moov);

    if (!trak) return;

    const info = getFpsInfo(trak);

    if (!info) return;

    const fps = info.fps;

    let target = 0;

    if (Math.abs(fps - 60) < 2) {
      target = 60;
    } else if (Math.abs(fps - 120) < 4) {
      target = 120;
    }

    if (!target) return;

    const stts = trak.findDeep(
      "mdia",
      "minf",
      "stbl",
      "stts"
    );

    if (!stts) return;

    const delta = Math.max(
      1,
      Math.round(info.timescale / target)
    );

    const payload = concat([
      u32(0),
      u32(1),
      u32(info.totalSamples),
      u32(delta)
    ]);

    stts.payload = payload;
    stts.children = null;
    stts.prefix = new Uint8Array(0);
  }


  // ------------------------------------------------------------
  // OFFSETS
  // ------------------------------------------------------------

  function findOffsetsBox(trak) {
    const stbl = trak.findDeep(
      "mdia",
      "minf",
      "stbl"
    );

    if (!stbl) return null;

    return (
      stbl.find("stco") ||
      stbl.find("co64") ||
      null
    );
  }


  function readOffsets(box) {
    const p = getPayload(box);

    if (p.length < 8) return [];

    const count = readU32(p, 4);

    const offsets = [];

    let o = 8;

    if (box.type === "stco") {

      for (
        let i = 0;
        i < count && o + 4 <= p.length;
        i++
      ) {
        offsets.push({
          value: BigInt(readU32(p, o)),
          index: i
        });

        o += 4;
      }

    } else {

      for (
        let i = 0;
        i < count && o + 8 <= p.length;
        i++
      ) {
        offsets.push({
          value: readU64(p, o),
          index: i
        });

        o += 8;
      }
    }

    return offsets;
  }


  function writeOffsets(box, offsets) {
    const old = getPayload(box);

    const out = old.slice();

    let o = 8;

    for (const item of offsets) {

      if (box.type === "stco") {

        if (
          item.value < 0n ||
          item.value > 0xffffffffn
        ) {
          fail(
            "Offset no cabe en stco; se requiere co64."
          );
        }

        view(out).setUint32(
          o,
          Number(item.value),
          false
        );

        o += 4;

      } else {

        view(out).setBigUint64(
          o,
          item.value,
          false
        );

        o += 8;
      }
    }

    box.payload = out;
  }


  function shiftAllOffsets(moov, delta) {
    if (!delta) return;

    const tracks = moov.findAll("trak");

    for (const trak of tracks) {

      const box = findOffsetsBox(trak);

      if (!box) continue;

      const offsets = readOffsets(box);

      for (const item of offsets) {
        item.value += BigInt(delta);
      }

      writeOffsets(box, offsets);
    }
  }


  // ------------------------------------------------------------
  // DEEP REPLACE
  // ------------------------------------------------------------

  function removeMetadata(moov) {

    const udta = moov.find("udta");

    if (!udta || !udta.children) return;

    const meta = udta.find("meta");

    if (!meta || !meta.children) return;

    const ilst = meta.find("ilst");

    if (!ilst || !ilst.children) return;

    ilst.children =
      ilst.children.filter(
        b =>
          b.type !== "\xa9cmt" &&
          b.type !== "cprt" &&
          b.type !== "\xa9aut"
      );
  }


  // ------------------------------------------------------------
  // PARSE FILE
  // ------------------------------------------------------------

  function parseFile(bytes) {

    const boxes =
      parseChildren(
        bytes,
        0,
        bytes.length
      );

    const ftyp =
      boxes.find(b => b.type === "ftyp");

    const moov =
      boxes.find(b => b.type === "moov");

    const mdat =
      boxes.find(b => b.type === "mdat");

    if (!ftyp) {
      fail("No se encontró ftyp.");
    }

    if (!moov) {
      fail("No se encontró moov.");
    }

    if (!mdat) {
      fail("No se encontró mdat.");
    }

    const mvhd =
      moov.find("mvhd");

    if (!mvhd) {
      fail("No se encontró mvhd.");
    }

    return {
      boxes,
      ftyp,
      moov,
      mdat,
      mvhd
    };
  }


  // ------------------------------------------------------------
  // APPLY PATCH
  // ------------------------------------------------------------

  function applyPatch(bytes) {

    const parsed = parseFile(bytes);

    const originalMoov =
      parsed.moov;

    const moov =
      cloneTree(originalMoov);

    /*
     * IMPORTANTE:
     *
     * mvhd NO se modifica.
     *
     * No se cambia:
     * - version
     * - creation time
     * - modification time
     * - timescale
     * - duration
     *
     * Tampoco se escribe 0xFF en mvhd.
     */

    patchFps(moov);

    removeMetadata(moov);

    injectEncoderTag(
      moov,
      ENCODER_TAG
    );

    const oldMoovSize =
      originalMoov.serialize().length;

    const newMoovBytes =
      moov.serialize();

    const newMoovSize =
      newMoovBytes.length;

    const delta =
      newMoovSize -
      oldMoovSize;

    /*
     * Si moov está antes de mdat,
     * el crecimiento del moov desplaza
     * físicamente los datos de mdat.
     */

    if (
      originalMoov.start <
      parsed.mdat.start
    ) {
      shiftAllOffsets(
        moov,
        delta
      );
    }

    const finalMoov =
      moov.serialize();

    const output = [];

    for (const box of parsed.boxes) {

      if (box.type === "moov") {
        output.push(finalMoov);
      } else {
        output.push(
          bytes.slice(
            box.start,
            box.end
          )
        );
      }
    }

    return concat(output);
  }


  // ------------------------------------------------------------
  // BYTE CLEANUP
  // ------------------------------------------------------------

  function byteCleanup(bytes) {

    const replacements = [
      [
        "ShoreUploader-v2.0.3",
        "TAY"
      ],
      [
        "shoreuploader-coded",
        "TAY"
      ],
      [
        "shoreuploader.com",
        "TAY"
      ]
    ];

    const out = bytes.slice();

    for (const [
      from,
      to
    ] of replacements) {

      const a = strN(from);
      const b = strN(to);

      if (b.length > a.length) {
        continue;
      }

      for (
        let i = 0;
        i + a.length <= out.length;
        i++
      ) {

        let match = true;

        for (
          let j = 0;
          j < a.length;
          j++
        ) {
          if (
            out[i + j] !== a[j]
          ) {
            match = false;
            break;
          }
        }

        if (!match) continue;

        out.set(b, i);

        for (
          let j = b.length;
          j < a.length;
          j++
        ) {
          out[i + j] = 0;
        }
      }
    }

    return out;
  }


  // ------------------------------------------------------------
  // CLI
  // ------------------------------------------------------------

  async function main() {

    const args =
      typeof process !== "undefined"
        ? process.argv.slice(2)
        : [];

    if (args.length < 2) {

      console.error(
        "Uso: node nex_patcher.js input.mp4 output.mp4"
      );

      return;
    }

    const fs =
      await import("node:fs/promises");

    const input =
      new Uint8Array(
        await fs.readFile(args[0])
      );

    const patched =
      applyPatch(input);

    const cleaned =
      byteCleanup(patched);

    await fs.writeFile(
      args[1],
      cleaned
    );

    console.log(
      "OK:",
      args[0],
      "->",
      args[1]
    );
  }


  if (
    typeof process !== "undefined" &&
    process.argv
  ) {
    main().catch(err => {
      console.error(
        "ERROR:",
        err.message
      );

      process.exitCode = 1;
    });
  }

})();
