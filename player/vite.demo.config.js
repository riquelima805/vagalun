import { defineConfig } from 'vite';

// `npm run build:demo` -> builda o index.html de demonstração como site estático
// (útil pra hospedar uma página "veja o player funcionando" separada da lib).
export default defineConfig({
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true
  }
});
