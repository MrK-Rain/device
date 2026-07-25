import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["dist/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
    },
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Without these two, the base no-unused-vars rule cannot see that a
      // component referenced only inside JSX is in fact used.
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "no-unused-vars": ["error", { varsIgnorePattern: "^React$" }],
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: "go through the storage adapter" },
        { name: "sessionStorage", message: "go through the storage adapter" },
      ],
    },
  },
];
