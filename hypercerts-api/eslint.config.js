import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "error",
      "no-implicit-coercion": "error",
      "no-param-reassign": ["error", { props: true }],
      "no-shadow": "error",
      "no-var": "error",
      "prefer-const": ["error", { destructuring: "all" }],
    },
  },
  {
    files: ["tooling/installer.js", "tooling/seed.js", "tooling/lint-lua.js"],
    rules: {
      "no-console": "off",
    },
  },
];
