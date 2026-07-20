// vitest.config.js — standalone config for the Metalstorm native-game client
// JS tree (data/games/metalstorm/client). This module tree is plain ESM,
// separate from client/src (TypeScript, bundled by Vite) — it never imports
// from client/src and has no build step of its own, so it gets its own tiny
// vitest project rather than joining the client/ suite.
//
// Run from client/ (only place vitest is installed so far):
//   npx vitest run --config ../data/games/metalstorm/client/vitest.config.js \
//     --root ../data/games/metalstorm/client
export default { test: { include: ['**/*.test.js'], environment: 'node' } };
