/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        paper: { DEFAULT: "var(--paper)", muted: "var(--paper-muted)" },
        card: "var(--surface-card)",
        ink: {
          50: "var(--ink-50)", 100: "var(--ink-100)", 200: "var(--ink-200)", 300: "var(--ink-300)",
          400: "var(--ink-400)", 500: "var(--ink-500)", 600: "var(--ink-600)", 700: "var(--ink-700)",
          800: "var(--ink-800)", 900: "var(--ink-900)",
        },
        brand: {
          50: "var(--brand-50)", 100: "var(--brand-100)", 200: "var(--brand-200)", 300: "var(--brand-300)",
          400: "var(--brand-400)", 500: "var(--brand-500)", 600: "var(--brand-600)", 700: "var(--brand-700)",
          800: "var(--brand-800)", 900: "var(--brand-900)",
          action: "var(--brand-action)", "action-hover": "var(--brand-action-hover)",
        },
        chrome: {
          DEFAULT: "var(--surface-chrome)", muted: "var(--surface-chrome-muted)",
          fg: "var(--chrome-fg)", "fg-muted": "var(--chrome-fg-muted)", border: "var(--chrome-border)",
          active: "var(--chrome-active-bg)", "active-fg": "var(--chrome-active-fg)", "active-border": "var(--chrome-active-border)",
        },
        positive: { DEFAULT: "var(--positive)", surface: "var(--positive-surface)", text: "var(--positive-text)", border: "var(--positive-border)" },
        negative: { DEFAULT: "var(--negative)", surface: "var(--negative-surface)", text: "var(--negative-text)", border: "var(--negative-border)" },
        warning: { DEFAULT: "var(--warning)", surface: "var(--warning-surface)", text: "var(--warning-text)", border: "var(--warning-border)" },
      },
      borderRadius: { sm: "6px", md: "8px", lg: "12px", xl: "16px" },
      boxShadow: {
        card: "var(--shadow-card)",
        sm: "var(--shadow-sm)",
        pop: "var(--shadow-pop)",
        focus: "var(--shadow-focus)",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Pretendard", "sans-serif"],
        mono: ["ui-monospace", "SF Mono", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
