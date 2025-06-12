import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', './*.mjs'],
  },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/prefer-for-of': 'off',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { 'vars': 'all', 'args': 'none' }
      ],
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-namespace': 'error',
      'linebreak-style': ['error', 'unix'],
      'no-irregular-whitespace': ['error', { 'skipComments': true }],
      'no-alert': 'error',
      'prefer-const': 'error',
      'no-return-assign': 'error',
      'no-useless-call': 'error',
      'no-useless-concat': 'error'
    }
  }
);
