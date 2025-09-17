// esbuild.config.js
const { build } = require('esbuild');

build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/index.js',
  sourcemap: true,
  external: ['@aws-sdk/client-sns'],
}).catch(() => process.exit(1));
