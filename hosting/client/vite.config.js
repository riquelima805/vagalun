import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Redireciona quem acessa a raiz (ex: alguém abre localhost:5173/ direto,
// sem o prefixo /app/) direto pro painel — sem isso o Vite mostra aquela
// mensagem confusa "did you mean to visit /app/sites instead?" pro usuário,
// já que o build inteiro usa base: '/app/'.
function redirectRootToApp() {
  return {
    name: 'redirect-root-to-app',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/' || req.url === '') {
          res.statusCode = 302
          res.setHeader('Location', '/app/')
          res.end()
          return
        }
        next()
      })
    }
  }
}

export default defineConfig({
  base: '/app/',
  plugins: [react(), redirectRootToApp()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: ['vagalun.shop', 'www.vagalun.shop', 'novagalun.shop'],
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  }
})

