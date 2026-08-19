// encode_sprites.mjs — impostor sprite PNG → KTX2 (UASTC + Zstd, mipmapped).
// usage: node encode_sprites.mjs [stem ...]   (default: all four infantry/civ stems)
// Same encoder settings as encode.mjs; sprite file layout instead of the
// 5-map PBR set: `<stem>_impostor.png` (sRGB, alpha cutout) plus an optional
// `<stem>_impostor_team.png` (linear R8 team mask).
import { encodeToKTX2 } from 'babylonpress-ktx2-encoder';
import { fixupEncoded } from './ktx2_dfd.mjs';
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const STEMS = process.argv.length > 2 ? process.argv.slice(2)
  : ['ms_soldiers_s1', 'ms_engineers_s1', 'ms_civilians', 'ms_militia'];

const decode = async (buffer) => {
  const png = PNG.sync.read(Buffer.from(buffer));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
};

async function enc(name, srgb) {
  const src = readFileSync(`out/${name}.png`);
  const out = await encodeToKTX2(new Uint8Array(src), {
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
  writeFileSync(`out/${name}.ktx2`, fixupEncoded(out));
  console.log(`[encode] ${name}.ktx2 ${(out.length / 1024).toFixed(0)} KiB (srgb=${srgb})`);
}

for (const stem of STEMS) {
  await enc(`${stem}_impostor`, true);
  if (existsSync(`out/${stem}_impostor_team.png`)) await enc(`${stem}_impostor_team`, false);
}
