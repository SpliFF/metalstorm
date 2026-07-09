#version 300 es
// fullscreen-tri.vert.glsl — Metalstorm reusable full-screen pass vertex.
//
// NATIVE WebGL2 / GLSL ES 3.00 (PLAN-metalstorm.md §9). A single oversized
// triangle covering the viewport, generated from gl_VertexID — the caller
// binds NO vertex buffer and issues gl.drawArrays(TRIANGLES, 0, 3). Emits vUV
// in [0,1] for any screen-space composite (shockwave-composite.frag.glsl and
// future post passes). Standard trick; avoids shipping a quad VBO per pass.

precision highp float;

out vec2 vUV;

void main() {
    // (0,0) (2,0) (0,2) in UV → clip covers [-1,1]² with a single triangle.
    vUV = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(vUV * 2.0 - 1.0, 0.0, 1.0);
}
