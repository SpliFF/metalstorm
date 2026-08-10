// encode_maps.mjs — single-file PNG → KTX2 (UASTC + Zstd, mipmapped).
// usage: node encode_maps.mjs <out.ktx2> <in.png> [srgb|linear]
//
// Same encoder + settings as encode.mjs / encode_sprites.mjs, but addressed
// by path instead of by the unit-forge's out/<stem>_<map>.png convention —
// generators that write elsewhere (tools/mapgen/gen_vegetation_models.py
// emits straight into a map package's objects3d/) use this entry point.
// Transfer function matters: diffuse/emissive/impostor colour are sRGB,
// ORM / team masks / normals are linear.
import { encodeToKTX2 } from 'babylonpress-ktx2-encoder';
import { fixupEncoded } from './ktx2_dfd.mjs';
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'fs';

const [out, src, mode = 'srgb'] = process.argv.slice(2);
if (!out || !src) {
  console.error('usage: node encode_maps.mjs <out.ktx2> <in.png> [srgb|linear]');
  process.exit(2);
}
const srgb = mode !== 'linear';

const decode = async (buffer) => {
  const png = PNG.sync.read(Buffer.from(buffer));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
};

const ktx2 = await encodeToKTX2(new Uint8Array(readFileSync(src)), {
  isUASTC: true,
  generateMipmap: true,
  needSupercompression: true,
  isPerceptual: srgb,
  isSetKTX2SRGBTransferFunc: srgb,
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
writeFileSync(out, fixupEncoded(ktx2));
console.log(`[encode] ${out} ${(ktx2.length / 1024).toFixed(0)} KiB (srgb=${srgb})`);
