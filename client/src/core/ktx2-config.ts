/**
 * KTX2 / Basis Universal transcoder configuration.
 *
 * Importing this module registers Babylon's KTX2 texture loader and pins
 * every transcoder asset URL to a CDN copy. After the KTX2 migration every
 * GPU texture (unit + feature + terrain + minimap) is `.ktx2`; the loader
 * transcodes UASTC/ETC1S to whichever compressed format the GPU prefers
 * (BC7/ASTC/ETC2/BC3).
 *
 * The decoder lazily downloads its JS module + WASM transcoders + Zstd
 * decoder on first KTX2 load. The stock defaults leave `wasmZSTDDecoder`
 * null and rely on each transcoder's hard-coded fallback path, which has
 * historically been flaky (one missing module sinks every KTX2 load with
 * the misleading "BasisLzEtc1sImageTranscoder.decodePalettes — Cannot
 * convert undefined to unsigned int" error). Setting every URL
 * explicitly makes the dependency chain auditable in DevTools' Network
 * tab.
 */

import '@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader.js';
import { KhronosTextureContainer2 } from '@babylonjs/core/Misc/khronosTextureContainer2.js';

const KTX2_CDN = 'https://cdn.babylonjs.com';

KhronosTextureContainer2.URLConfig = {
    jsDecoderModule:        `${KTX2_CDN}/babylon.ktx2Decoder.js`,
    wasmUASTCToASTC:        `${KTX2_CDN}/ktx2Transcoders/1/uastc_astc.wasm`,
    wasmUASTCToBC7:         `${KTX2_CDN}/ktx2Transcoders/1/uastc_bc7.wasm`,
    wasmUASTCToRGBA_UNORM:  `${KTX2_CDN}/ktx2Transcoders/1/uastc_rgba8_unorm_v2.wasm`,
    wasmUASTCToRGBA_SRGB:   `${KTX2_CDN}/ktx2Transcoders/1/uastc_rgba8_srgb_v2.wasm`,
    wasmUASTCToR8_UNORM:    `${KTX2_CDN}/ktx2Transcoders/1/uastc_r8_unorm.wasm`,
    wasmUASTCToRG8_UNORM:   `${KTX2_CDN}/ktx2Transcoders/1/uastc_rg8_unorm.wasm`,
    jsMSCTranscoder:        `${KTX2_CDN}/ktx2Transcoders/1/msc_basis_transcoder.js`,
    wasmMSCTranscoder:      `${KTX2_CDN}/ktx2Transcoders/1/msc_basis_transcoder.wasm`,
    wasmZSTDDecoder:        `${KTX2_CDN}/zstddec.wasm`,
};
