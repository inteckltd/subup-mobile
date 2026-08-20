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
        primary: '#0B6E4F',
        accent: '#B8F236',
        ink: '#121212',
        muted: '#60736C',
        border: '#F3F4F6',
        background: '#F4F6F5',
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
