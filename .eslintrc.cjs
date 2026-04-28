// Turn off next specific rules in non-app contexts
const nextOff = Object.keys(require('@next/eslint-plugin-next').rules).reduce((acc, rule) => {
  acc[`@next/next/${rule}`] = 'off';
  return acc;
}, {});

module.exports = {
  extends: ['@gauntletnetworks'],
  rules: {
    ...nextOff,
    '@typescript-eslint/no-explicit-any': 'warn',
  },
  ignorePatterns: ['src/generated/*/**'],
};
