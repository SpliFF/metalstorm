// encode.mjs — PNG → KTX2 (UASTC + Zstd, mipmapped).
// usage: node encode.mjs [stem]   (default: fable_tank)
// Matches the repo's historical toktx settings (--encode uastc --zcmp
// --genmipmap, sRGB for diffuse/emissive, linear for ORM/team mask).
// Encoder: babylonpress-ktx2-encoder (Basis Universal WASM, works in Node
// where KTX-Software binaries aren't obtainable).
import { encodeToKTX2 } from 'babylonpress-ktx2-encoder';
import { fixupEncoded } from './ktx2_dfd.mjs';
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'fs';

const STEM = process.argv[2] || 'fable_tank';

const decode = async (buffer) => {
  const png = PNG.sync.read(Buffer.from(buffer));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
};

async function enc(name, srgb, normal = false) {
  const src = readFileSync(`out/${name}.png`);
  const out = await encodeToKTX2(new Uint8Array(src), {
    isUASTC: true,
    generateMipmap: true,
    needSupercompression: true,        // Zstd, like --zcmp
    isPerceptual: srgb,
    isNormalMap: normal,
    isSetKTX2SRGBTransferFunc: srgb,   // --assign_oetf srgb / linear
    isKTX2File: true,
    uastcLDRQualityLevel: 2,
    enableRDO: true,
    rdoQualityLevel: 1.0,
    imageDecoder: decode,
  });
  // `fixupEncoded` sizes the DFD's `bytesPlane0`: the Basis Universal
  // WASM encoder zeroes it on supercompressed output per KTX2 <= 2.0.3,
  // which spec 2.0.4 forbids (`ktx validate` warning-6030). See
  // ktx2_dfd.mjs.
  writeFileSync(`out/${name}.ktx2`, fixupEncoded(out));
  console.log(`[encode] ${name}.ktx2 ${(out.length / 1024).toFixed(0)} KiB (srgb=${srgb})`);
}

await enc(`${STEM}_diffuse`, true);
await enc(`${STEM}_emissive`, true);
await enc(`${STEM}_orm`, false);
await enc(`${STEM}_team`, false);
await enc(`${STEM}_normals`, false, true);
