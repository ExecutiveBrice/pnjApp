import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
export default tseslint.config(
  { ignores: ['node_modules/**', 'www/**', '.angular/**', 'android/**', 'ios/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  { files: ['**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'error' } },
);
