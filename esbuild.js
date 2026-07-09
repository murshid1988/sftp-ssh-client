const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const config = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // ssh2 ships an optional native crypto binding (cpu-features/sshcrypto.node)
  // that esbuild can't bundle. Keep it external and rely on node_modules
  // being shipped alongside the extension instead.
  external: ['vscode', 'ssh2', 'cpu-features'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: !watch,
};

async function run() {
  if (watch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    console.log('watching...');
  } else {
    await esbuild.build(config);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
