import { resolve } from 'path';
import { defineConfig } from 'vite';

// `npm run build:lib` -> gera dist/vagalun-player.{es.js,umd.cjs,iife.js} + vagalun-player.css
// Isso é o arquivo que sobe no CDN e é embutido nos sites com <script src="...">.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve(__dirname, 'src/player.js'),
      name: 'VagalunPlayer',
      formats: ['es', 'umd', 'iife'],
      fileName: (format) => {
        if (format === 'es') return 'vagalun-player.es.js';
        if (format === 'umd') return 'vagalun-player.umd.cjs';
        return 'vagalun-player.iife.js';
      }
    },
    rollupOptions: {
      output: {
        // CSS final sempre com o mesmo nome, independente do formato do JS
        assetFileNames: (asset) =>
          asset.name && asset.name.endsWith('.css') ? 'vagalun-player.css' : 'assets/[name][extname]'
      }
    },
    // hls.js é bundlado junto (o site que incorpora não precisa instalar nada) —
    // mas é carregado via import() dinâmico só quando a fonte é HLS, então não pesa
    // no caminho de MP4/progressivo puro (que é o caso comum do gateway/raw/:fileId).
    target: 'es2018',
    minify: 'esbuild'
  },
  define: {
    __VAGALUN_PLAYER_VERSION__: JSON.stringify(process.env.npm_package_version || '1.0.0')
  }
});
