# 🚀 PLATAFORMA DE HOSPEDAGEM ESTÁTICA

**Hospedagem barata + CDN descentralizada + Pagamento via Solana (⚡ destaque)**

---

## 📊 O QUE É?

Uma **plataforma SaaS web** para hospedar sites estáticos com:

✅ **Upload de ZIP** → Deploy automático  
✅ **URLs públicas** em segundos  
✅ **Medição de storage + tráfego** por site/usuário  
✅ **Cobrança flexível**: Pix, Stripe, **Solana (destaque!)**  
✅ **Design vermelho minimalista** (Vite React)  
✅ **Backend robusto** (Node.js/Express)

---

## 🏗️ ARQUITETURA

```
┌─────────────────────────────────────────────────────┐
│         FRONTEND (Vite + React)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │  Login   │ │Dashboard │ │ Billing (Solana) │   │
│  └──────────┘ └──────────┘ └──────────────────┘   │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │  Sites   │ │  Upload  │ │   SiteDetail     │   │
│  └──────────┘ └──────────┘ └──────────────────┘   │
└────────────────────┬────────────────────────────────┘
                     │ Axios API
                     ↓
┌─────────────────────────────────────────────────────┐
│        BACKEND (Express.js + Node.js)               │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │  Auth    │ │  Sites   │ │ Upload/Deploy    │   │
│  └──────────┘ └──────────┘ └──────────────────┘   │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │ Billing  │ │ Stripe   │ │ PIX/Solana Pay   │   │
│  └──────────┘ └──────────┘ └──────────────────┘   │
└────────────────────┬────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        ↓            ↓            ↓
    Uploads/    Users/Sites   Payments
    ZIP Files   (Memory DB)    (Mock)
```

---

## 📋 ESTRUTURA DO PROJETO

```
hosting-platform/
├── server.js                 # Backend Express
├── package.json              # Dependências
├── .env.example              # Variáveis de ambiente
└── client/                   # Frontend React/Vite
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── App.css
        ├── components/
        │   ├── Header.jsx
        │   └── Header.css
        └── pages/
            ├── Login.jsx
            ├── Register.jsx
            ├── Dashboard.jsx       # 📊 Stats + Quick Sites
            ├── Sites.jsx           # 📦 Upload + Gerenciar
            ├── SiteDetail.jsx      # 🔧 Detalhes + Deploy
            ├── Billing.jsx         # 💰 Solana/Stripe/PIX
            └── Auth.css / Dashboard.css / Sites.css / Billing.css / SiteDetail.css
```

---

## 🚀 QUICK START

### 1️⃣ Pré-requisitos
```bash
Node.js 16+
npm ou yarn
Git
```

### 2️⃣ Clonar e Instalar

```bash
cd hosting-platform

# Backend
npm install

# Frontend
cd client
npm install
cd ..
```

### 3️⃣ Configurar Variáveis de Ambiente

```bash
cp .env.example .env
```

Edite `.env`:
```env
PORT=3000
JWT_SECRET=sua-chave-super-secreta

# Stripe (opcional, para testes)
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_PUBLISHABLE_KEY=pk_test_xxx

# Solana
SOLANA_WALLET=7gBCm6Kn2M4tL8pQ2xR9sZ...

CLIENT_URL=http://localhost:5173
```

### 4️⃣ Rodar em Desenvolvimento

**Terminal 1 - Backend:**
```bash
npm run dev
# Rodará em http://localhost:3000
```

**Terminal 2 - Frontend:**
```bash
cd client
npm run dev
# Rodará em http://localhost:5173
```

### 5️⃣ Acessar

Abra http://localhost:5173 no navegador

---

## 💻 COMO USAR

### Criar Conta
1. Clique em "Criar Conta"
2. Preencha Email, Nome, Senha
3. Pronto! Você está logado

### Criar um Site
1. Vá para "Meus Sites" → "Novo Site"
2. Preencha nome e domínio (opcional)
3. Site criado!

### Fazer Upload (Deploy)
1. Crie um arquivo ZIP com:
   ```
   site.zip
   ├── index.html
   ├── css/style.css
   ├── js/script.js
   └── images/logo.png
   ```
2. Clique em "Upload ZIP" no site
3. Aguarde 2-5 segundos
4. **Seu site estará online!** 🎉

### Acessar Seu Site
- A URL gerada aparece em cada card de site
- Exemplo: `https://seu-site-id.plataforma.local`
- Copie e compartilhe com qualquer pessoa

### Gerenciar Cobrança
1. Vá para "Cobrança"
2. Escolha um plano (Starter/Basic/Pro)
3. **Solana é recomendado** ⚡ (mais rápido, barato)
4. Coloque endereço de wallet e pague
5. Saldo é ativado imediatamente

---

## 💰 SISTEMA DE COBRANÇA

### Planos

| Plano | Preço | Storage | Tráfego |
|-------|-------|---------|---------|
| **Starter** | R$ 10 | 2 GB | 5 GB |
| **Basic** | R$ 20 | 4 GB | 15 GB |
| **Pro** | R$ 30 | 8 GB | 40 GB |

### Métodos de Pagamento

#### ⚡ **Solana (DESTAQUE)**
- **Mais rápido**: transação em 400ms
- **Mais barato**: taxa de ~$0.00025
- **Sem intermediários**: P2P direto
- Wallets: Phantom, TrustWallet, Ledger
- Excelente para economia digital

#### 💳 Stripe
- Cartão de crédito (Visa, Mastercard, Amex)
- Cobrança recorrente mensal
- Integração com webhook para verificação

#### 🏦 PIX
- Transferência instantânea via PIX
- Gera QR Code com 30 min de validade
- Ideal para Brasil

---

## 🔐 AUTENTICAÇÃO & SEGURANÇA

### JWT Token
- Gerado ao login
- Armazenado no localStorage
- Incluso em Authorization header
- Validade: 7 dias

### Senha
- Hasheada com bcrypt (salt rounds: 10)
- Nunca armazenada em texto plano

### Endpoints Protegidos
Todas as rotas `/api/` (exceto `/auth/login` e `/auth/register`) requerem token válido.

---

## 📡 API ENDPOINTS

### Auth
- `POST /api/auth/register` - Criar conta
- `POST /api/auth/login` - Fazer login
- `GET /api/auth/me` - Dados do usuário (requer token)

### Sites
- `POST /api/sites` - Criar site
- `GET /api/sites` - Listar meus sites
- `GET /api/sites/:siteId` - Detalhes do site
- `POST /api/sites/:siteId/upload` - Upload ZIP (multipart/form-data)

### Billing
- `GET /api/billing/plans` - Listar planos
- `POST /api/billing/checkout` - Session Stripe
- `POST /api/billing/pix` - Gerar QR PIX
- `POST /api/billing/solana` - Iniciar pagamento Solana
- `GET /api/billing/pix/:paymentId` - Verificar status PIX

### Usage
- `GET /api/usage` - Storage + Tráfego consumidos

### Health
- `GET /health` - Status do servidor

---

## 🎨 DESIGN & CORES

### Tema Vermelho Minimalista

**Paleta Principal:**
- `--primary-red: #ee3434` (Vermelho principal)
- `--dark-red: #c41e1e` (Vermelho escuro)
- `--light-red: #ff6b6b` (Vermelho claro)
- `--bg-dark: #0a0a0a` (Preto quase puro)
- `--bg-darker: #050505` (Preto absoluto)

**Gradientes:**
- Headers: `linear-gradient(90deg, #0a0a0a 0%, #1a0000 100%)`
- Hover: `rgba(238, 52, 52, 0.15)`

**Tipografia:**
- System fonts (SF Pro, Segoe UI, Roboto)
- Font weight: 400/500/600/bold

---

## 📦 DEPENDÊNCIAS PRINCIPAIS

**Backend:**
- `express` - Framework web
- `cors` - CORS middleware
- `multer` - Upload de arquivos
- `unzipper` - Extrair ZIPs
- `stripe` - Pagamentos Stripe
- `jsonwebtoken` - Autenticação JWT
- `bcrypt` - Hash de senhas

**Frontend:**
- `react` - UI library
- `react-router-dom` - Roteamento
- `axios` - HTTP client
- `lucide-react` - Ícones
- `@stripe/react-stripe-js` - Stripe integration (opcional)
- `vite` - Build tool

---

## 🧪 TESTANDO

### Criar Conta de Teste
```
Email: teste@example.com
Senha: senha123
Nome: Test User
```

### Teste Solana Mock
1. Vá para Billing
2. Escolha qualquer plano
3. Coloque wallet (fake): `7gBCm6Kn2M4tL8pQ2xR9sZ...`
4. Clique em "Pagar com Solana"
5. Você receberá um mock de pagamento

### Teste PIX Mock
1. Vá para Billing
2. Escolha PIX como método
3. QR Code será gerado (fake)
4. Após 5 segundos, será marcado como "completed"

---

## 🔄 FLUXO DE DEPLOY

```
1. Usuário faz upload de ZIP
   ↓
2. Backend recebe arquivo via multer
   ↓
3. Extrai ZIP em /sites/:siteId/
   ↓
4. Calcula tamanho de storage
   ↓
5. Retorna resposta com site atualizado
   ↓
6. Frontend atualiza card
   ↓
7. URL fica pública imediatamente
   ↓
8. GET requests servem arquivos de /sites/:siteId/
```

---

## 📊 MEDIÇÃO

O sistema mede:
- **Storage**: tamanho total dos arquivos (em bytes)
- **Tráfego**: simulado (em produção, viria de CDN/gateway logs)

Ambos são mostrados no Dashboard e usados para:
- ✅ Verificar limite do plano
- ✅ Calcular cobrança extra
- ✅ Pausar/limitar site se exceder

---

## 🚀 PRÓXIMOS PASSOS (PRODUÇÃO)

1. **Banco de dados real**
   - SQLite → PostgreSQL
   - Implementar schema de users, sites, payments

2. **Integração Stripe real**
   - Webhook para confirmação de pagamento
   - Verificar subscription status

3. **Integração Solana real**
   - Usar `@solana/web3.js` para verificar transações
   - Anchor program para on-chain billing

4. **Storage distribuído**
   - Integração com IPFS ou Arweave
   - Nós descentralizados para CDN

5. **SSL/TLS**
   - Certificados por domínio
   - Let's Encrypt integration

6. **Monitoramento**
   - Uptime tracking
   - Analytics de tráfego
   - Error logging

7. **Rate limiting**
   - DDoS protection
   - API throttling

8. **Admin panel**
   - Gerenciar usuários
   - Relatórios de receita
   - Controle de wallets Solana

---

## 📝 NOTAS IMPORTANTES

### Segurança
- Em produção, usar HTTPS only
- JWT_SECRET deve ser muito longo e aleatório
- Implementar rate limiting
- Validar uploads (tamanho máximo, tipos permitidos)

### Performance
- Em produção, usar CDN (Cloudflare, etc)
- Cache de navegador para arquivos estáticos
- Compressão Gzip
- Minificação de assets

### Escalabilidade
- Storage de sites em objeto S3/R2
- Database replicada
- Load balancer (nginx)
- Message queue para jobs assíncronos

---

## 🆘 TROUBLESHOOTING

### Erro: "Port 3000 already in use"
```bash
# Mudar porta
PORT=3001 npm run dev

# Ou matar processo na porta
lsof -i :3000
kill -9 <PID>
```

### Erro: "CORS blocked"
Verifique se o backend está rodando e se CORS está configurado corretamente em `server.js`

### Upload não funciona
- Verifique tamanho do arquivo (máximo 100MB)
- Permissões da pasta `/uploads`
- Check se `unzipper` foi instalado

### JWT expirado
Faça login novamente para obter novo token

---

## 📞 SUPORTE

Dúvidas? Abra uma issue ou entre em contato!

---

## 📄 LICENÇA

MIT License - Use libremente!

---

**Made with ❤️ e Solana ⚡**
