import { Engine } from '@babylonjs/core';

/** Single upgrade point for reaching Babylon's underlying WebGL2 context.
 *  Babylon has no public accessor for the raw context; `_gl` is internal API.
 *  If a Babylon upgrade breaks this, fix it HERE only. */
export function getEngineGl(engine: Engine): WebGL2RenderingContext {
    const gl = (engine as unknown as { _gl?: WebGL2RenderingContext })._gl;
    if (!gl) throw new Error('Babylon Engine._gl unavailable — Babylon internal API changed');
    return gl;
}
