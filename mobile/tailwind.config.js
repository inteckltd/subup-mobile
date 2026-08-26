// Values are duplicated from src/theme/tokens.ts (tailwind.config.js runs in
// plain Node/CommonJS, so it can't import the TS source directly). Keep the
// two files in sync when changing brand colours/radii.

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx,ts,tsx}', './src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        primary: '#032488',
        accent: '#05deed',
        ink: '#010101',
        muted: '#5C6B8A',
        border: '#F3F4F6',
        background: '#FEFEFD',
        danger: '#DC2626',
        gold: '#F2C14E',
      },
      borderRadius: {
        control: '16px',
        card: '40px',
        pill: '12px',
      },
      fontFamily: {
        sans: ['Manrope_400Regular'],
        'sans-medium': ['Manrope_500Medium'],
        'sans-bold': ['Manrope_700Bold'],
        'sans-extrabold': ['Manrope_800ExtraBold'],
      },
    },
  },
  plugins: [],
};
