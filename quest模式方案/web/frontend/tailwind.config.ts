import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          0: "#08080a",
          50: "#0b0b0d",
          100: "#101013",
          200: "#15151a",
          300: "#1b1b21",
          400: "#22222a",
          500: "#2c2c36",
          600: "#3a3a46",
          700: "#5a5a66",
          800: "#8a8a92",
          900: "#c8c8ce",
        },
        bone: "#ededea",
        whisper: "#a8a8a4",
        // Surgical accents
        lime: { DEFAULT: "#d4ff3a", soft: "#1f2a08" },
        amber: { DEFAULT: "#f4c95d", soft: "#2a2010" },
        sky: { DEFAULT: "#5b9dff", soft: "#0e1a2e" },
        mint: { DEFAULT: "#7dd87d", soft: "#102818" },
        ember: { DEFAULT: "#ff6b6b", soft: "#2a1212" },
        plum: { DEFAULT: "#c084fc", soft: "#1f1428" },
      },
      fontFamily: {
        sans: [
          "Manrope",
          "ui-sans-serif",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
        display: [
          "Instrument Serif",
          "ui-serif",
          "Georgia",
          "serif",
        ],
      },
      letterSpacing: {
        tightest: "-0.04em",
        widest2: "0.32em",
      },
      borderRadius: {
        xs: "2px",
      },
      boxShadow: {
        panel: "0 0 0 1px rgba(255,255,255,0.04), 0 30px 60px -30px rgba(0,0,0,0.6)",
        accent: "0 0 0 1px #d4ff3a33, 0 0 24px -4px #d4ff3a55",
      },
      backgroundImage: {
        grid: "linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px)",
        noise:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/><feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.06 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
      },
      animation: {
        "fade-up": "fadeUp 0.6s cubic-bezier(0.2,0.8,0.2,1) both",
        "scan": "scan 2.4s linear infinite",
        "pulse-soft": "pulseSoft 2s ease-in-out infinite",
        "marquee": "marquee 18s linear infinite",
      },
      keyframes: {
        fadeUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        scan: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        pulseSoft: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
        marquee: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
