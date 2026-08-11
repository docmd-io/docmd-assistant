import esbuild from 'esbuild';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

async function build() {
  const isWatch = process.argv.includes('--watch');

  if (isWatch) {
    const ctxEsm = await esbuild.context({
      entryPoints: ['src/index.ts'],
      outfile: 'dist/index.js',
      bundle: true,
      platform: 'neutral',
      format: 'esm',
      target: 'es2022',
      sourcemap: true,
      external: ['aiplug'],
      define: {
        'process.env.ENGINE_VERSION': JSON.stringify(pkg.version)
      }
    });

    const ctxCjs = await esbuild.context({
      entryPoints: ['src/index.ts'],
      outfile: 'dist/index.cjs',
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      sourcemap: true,
      external: ['aiplug'],
      define: {
        'process.env.ENGINE_VERSION': JSON.stringify(pkg.version)
      }
    });

    await ctxEsm.watch();
    await ctxCjs.watch();
    try {
      execSync('npx tsc --emitDeclarationOnly', { stdio: 'inherit' });
    } catch {}
    console.log(`👀 Watching docmd-assistant (v${pkg.version}) for changes...`);
    return;
  }

  // 1. Build ESM Node/Browser Headless Engine
  await esbuild.build({
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
    external: ['aiplug'],
    define: {
      'process.env.ENGINE_VERSION': JSON.stringify(pkg.version)
    }
  });

  // 2. Build CJS Module
  await esbuild.build({
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: true,
    external: ['aiplug'],
    define: {
      'process.env.ENGINE_VERSION': JSON.stringify(pkg.version)
    }
  });

  // 3. Emit TypeScript Declarations
  execSync('npx tsc --emitDeclarationOnly', { stdio: 'inherit' });

  console.log(`✅ docmd-assistant headless library build complete (v${pkg.version})!`);
  console.log(' - dist/index.js (ESM)');
  console.log(' - dist/index.cjs (CJS)');
  console.log(' - dist/index.d.ts (Types)');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});