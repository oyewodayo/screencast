/** @type {import('tailwindcss').Config} */
export default {
  purge: ['./src/**/*.{js,jsx,ts,tsx}', './index.html'],
  // darkMode: false, // or 'media' or 'class'
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx,css,md,mdx,html,json,scss}',
  ],
  darkMode: 'class', // or 'media'
  theme: {
    extend: {},
  },
  plugins: [],
}

