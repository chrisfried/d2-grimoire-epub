import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  eslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      'no-console': 'off',
      'no-empty': 'off',
      'no-implicit-coercion': 'error',
      'arrow-body-style': ['error', 'as-needed'],
      'no-return-await': 'error',
      'prefer-regex-literals': 'error',
      'prefer-promise-reject-errors': 'error',
      'require-atomic-updates': 'off',
      '@typescript-eslint/explicit-member-accessibility': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-use-before-define': ['error', { functions: false }],
      '@typescript-eslint/no-extraneous-class': 'error',
      '@typescript-eslint/no-this-alias': 'error',
      '@typescript-eslint/no-unnecessary-qualifier': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/prefer-function-type': 'error',
      '@typescript-eslint/prefer-for-of': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/array-type': 'error',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'error',
      '@typescript-eslint/prefer-as-const': 'error',
      '@typescript-eslint/prefer-reduce-type-parameter': 'error',
      '@typescript-eslint/unified-signatures': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '(^_|[iI]gnored)',
          argsIgnorePattern: '(^_|[iI]gnored)',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    ignores: ['built/**', 'node_modules/**', 'epub/**', 'assets/**', 'output/**'],
  },
];
