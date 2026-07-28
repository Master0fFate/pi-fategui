import type { Config } from 'tailwindcss';

export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#090b12',
        panel: '#10131d',
        elevated: '#171b28',
        line: '#272c3a',
        accent: '#7c6cff',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['SFMono-Regular', 'Cascadia Code', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
