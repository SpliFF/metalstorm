// ui/vitest.config.js — standalone Vitest config for the native-UI JS tree
// (ui/lib/*.js, ui/widgets/*.js), which lives outside client/src and needs
// its own root. Run from client/ (where vitest is installed):
//
//   cd client && npx vitest run --config ../data/games/metalstorm/ui/vitest.config.js --root ../data/games/metalstorm/ui

export default {
  test: {
    include: ['**/*.test.js'],
    environment: 'node',
  },
};
