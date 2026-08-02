import esbuild from 'esbuild';

async function build() {
  // 1. Build ESM Node/Browser Headless Engine
  await esbuild.build({
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
    external: ['aiplug']
  });

  // 2. Build CJS Module
  await esbuild.build({
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: true,
    external: ['aiplug']
  });

  console.log('✅ docmd-assistant headless library build complete!');
  console.log(' - dist/index.js (ESM)');
  console.log(' - dist/index.cjs (CJS)');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});