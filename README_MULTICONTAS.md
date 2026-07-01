# Suporte a Múltiplas Contas DeepSeek

## Visão Geral

O deepsproxy agora suporta múltiplas contas DeepSeek simultâneas com:
- **Pool de navegadores**: Cada conta tem seu próprio contexto isolado
- **Health check automático**: Monitoramento contínuo do status de cada conta
- **Rotação automática**: Requisições são distribuídas entre contas saudáveis
- **Perfis separados**: Cada conta mantém seu próprio estado de sessão

## Configuração

### Variáveis de Ambiente

#### `DEEPSEEK_ACCOUNTS` (Obrigatório para múltiplas contas)

Formato: `id1,caminho_perfil1,email1;id2,caminho_perfil2,email2`

Exemplos:

```bash
# Conta única (default)
DEEPSEEK_ACCOUNTS=default,/app/deepseek_profile

# Múltiplas contas
DEEPSEEK_ACCOUNTS=conta1,/app/deepseek_profiles/conta1,user1@email.com;conta2,/app/deepseek_profiles/conta2,user2@email.com;conta3,/app/deepseek_profiles/conta3
```

#### Outras Variáveis

```bash
# Timeout para detecção de input do chat (ms)
DEEPSPROXY_CHAT_INPUT_TIMEOUT_MS=8000

# Intervalo do health check entre contas (ms)
DEEPSPROXY_HEALTH_CHECK_INTERVAL_MS=60000

# Cache de headers PoW (ms)
DEEPSPROXY_POW_CACHE_TTL_MS=30000

# Modo headless do Playwright
PLAYWRIGHT_HEADLESS=true
```

## Docker Compose

### Exemplo com Múltiplas Contas

```yaml
version: '3.8'
services:
  deepsproxy:
    build: .
    ports:
      - "3000:3000"
    environment:
      - API_KEY=sua_api_key_segura
      - DEEPSEEK_ACCOUNTS=conta1,/app/deepseek_profiles/conta1;conta2,/app/deepseek_profiles/conta2
      - DEEPSPROXY_HEALTH_CHECK_INTERVAL_MS=60000
    volumes:
      - ./deepseek_profiles:/app/deepseek_profiles
    restart: unless-stopped
```

### Estrutura de Diretórios

```
deepseek_profiles/
├── conta1/
│   └── (estado da sessão da conta 1)
├── conta2/
│   └── (estado da sessão da conta 2)
└── conta3/
    └── (estado da sessão da conta 3)
```

## Setup Inicial das Contas

1. **Crie os diretórios de perfil**:
```bash
mkdir -p deepseek_profiles/conta1
mkdir -p deepseek_profiles/conta2
```

2. **Configure as variáveis de ambiente** no `.env` ou docker-compose.yml

3. **Inicie o servidor**:
```bash
docker-compose up -d
```

4. **Faça login manualmente** em cada conta (se necessário):
   - O sistema tentará fazer login automaticamente se os cookies estiverem salvos
   - Caso contrário, você precisará fazer login via navegador

## Monitoramento

### Health Check Endpoint

```bash
curl http://localhost:3000/health
```

Resposta:
```json
{
  "status": "ok",
  "accounts": {
    "total": 3,
    "healthy": 2,
    "unhealthy": 0,
    "suspended": 1
  },
  "timestamp": 1234567890
}
```

### Status das Contas

- `healthy`: Conta operacional e pronta para uso
- `login_required`: Necessário fazer login
- `suspended`: Conta suspensa pelo DeepSeek
- `unhealthy`: Erro temporário ou indisponível
- `initializing`: Em processo de inicialização

## Rotação Automática

O sistema automaticamente:
1. Seleciona a conta mais saudável (menor número de falhas consecutivas)
2. Distribui requisições entre contas disponíveis
3. Remove contas problemáticas da rotação até recuperação

## Troubleshooting

### Conta Suspensa

Se uma conta for suspensa:
1. O health check detectará automaticamente
2. A conta será removida da rotação
3. Use outra conta ou aguarde o fim da suspensão

### Login Necessário

Se o status for `login_required`:
1. Verifique se os cookies estão salvos no perfil
2. Pode ser necessário refazer login manualmente
3. Use ferramentas de desenvolvimento para extrair cookies

### Todas as Contas Indisponíveis

Se todas as contas estiverem indisponíveis:
- O endpoint `/health` mostrará 0 contas healthy
- As requisições retornarão erro "No healthy Playwright account available"
- Verifique o status de cada conta e faça login se necessário

## Segurança

- Mantenha os perfis em diretórios seguros
- Use API_KEY para autenticar requisições
- Não compartilhe arquivos de perfil entre instâncias
- Monitore regularmente o status das contas
