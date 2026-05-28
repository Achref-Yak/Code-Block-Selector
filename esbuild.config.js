const esbuild = require('esbuild');
const { copyFileSync, mkdirSync, existsSync } = require('fs');
const { join } = require('path');

async function build() {
  await esbuild.build({
    entryPoints: ['src/extension.ts', 'src/parser-worker.ts'],
    bundle: true,
    outdir: 'dist',
    external: ['vscode'],
    platform: 'node',
    target: 'es2020',
    format: 'cjs',
    sourcemap: true,
    minify: false,
    logLevel: 'info',
  });

  if (!existsSync('dist/parsers')) {
    mkdirSync('dist/parsers', { recursive: true });
  }

  const wasmFiles = [
    'tree-sitter.wasm',
    'tree-sitter-go.wasm',
    'tree-sitter-javascript.wasm',
    'tree-sitter-python.wasm',
    'tree-sitter-typescript.wasm',
  ];

  for (const file of wasmFiles) {
    const src = join('parsers', file);
    const dest = join('dist', 'parsers', file);
    if (existsSync(src)) {
      copyFileSync(src, dest);
    }
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
