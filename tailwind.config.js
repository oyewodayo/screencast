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
    extend: {
      colors:{
        background: "rgba(var(--background))",
        foreground: "rgba(var(--foreground))",
        card: "rgba(var(--card))",
        "card-foreground": "rgba(var(--card-foreground))",
        popover: "rgba(var(--popover))",
        "popover-foreground":"rgba(var(--popover-foreground))",
        primary: "rgba(var(--primary))",
        "primary-foreground": "rgba(var(--primary-foreground))",
        secondary: "rgba(var(--secondary))",
        "secondary-foreground": "rgba(var(--secondary-foreground))",
        muted: "rgba(var(--muted))",
        "muted-foreground": "rgba(var(--muted-foreground))",
        accent: "rgba(var(--accent))",
        "accent-foreground": "rgba(var(--accent-foreground))",
        destructive: "rgba(var(--destructive))",
        "destructive-foreground": "rgba(var(--destructive-foreground))",
        border: "rgba(var(--border))",
        input: "rgba(var(--input))",
        ring: "rgba(var(--ring))",
      }
    },
  },
  plugins: [],
}

