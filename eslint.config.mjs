import playwright from "eslint-plugin-playwright";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.venv/**", "playwright-report/**", "test-results/**", "reports/**", "apps/web/src/api-types.ts"] },
  {
    files: ["framework/**/*.ts", "tests/**/*.ts", "playwright.config.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    // Rules that keep tests reliable. These apply to the page objects as well as the specs.
    files: ["framework/**/*.ts", "tests/**/*.ts"],
    plugins: { playwright },
    rules: {
      "playwright/no-wait-for-timeout": "error",
      "playwright/no-force-option": "error",
      "playwright/no-page-pause": "error",
      "playwright/missing-playwright-await": "error",
      "playwright/no-networkidle": "error",
      "playwright/no-eval": "error",
    },
  },
  {
    files: ["tests/**/*.ts"],
    plugins: { playwright },
    rules: {
      "playwright/no-focused-test": "error",
      "playwright/no-skipped-test": "error",
      "playwright/valid-expect": "error",
      "playwright/prefer-web-first-assertions": "error",
      "playwright/no-useless-not": "error",
      "playwright/no-conditional-in-test": "error",
      "playwright/expect-expect": ["error", { assertFunctionPatterns: ["^expect", "^readApiError$"] }],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    extends: [...tseslint.configs.recommended],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
