import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended
});

export default [
  ...compat.config({
    env: {
      browser: true,
      es2022: true
    },
    parser: "@typescript-eslint/parser",
    plugins: ["@typescript-eslint", "react-hooks", "react-refresh"],
    extends: [
      "eslint:recommended",
      "plugin:@typescript-eslint/recommended",
      "plugin:react-hooks/recommended"
    ],
    rules: {
      "react-refresh/only-export-components": [
        "error",
        { allowConstantExport: true }
      ]
    },
    settings: {
      react: {
        version: "detect"
      }
    }
  })
];
