// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // Reanimated shared values and PanResponder refs are updated from gesture
    // callbacks; React Compiler flags those as render-time mutations.
    files: [
      "src/features/games/components/PlayerLobbyRow.tsx",
      "src/features/games/components/TeamBoard.tsx",
    ],
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
    },
  },
]);
