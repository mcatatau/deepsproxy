/*
 * File: index.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { chatCompletions } from './routes/chat.ts';
import * as dotenv from 'dotenv';
import { browserPool, closePlaywright, addAccount, removeAccount, validateAccount, setAccountAsDefault } from './services/playwright.ts';
import { getContextLength, getTelemetryStats } from './services/telemetry.ts';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

dotenv.config();

export const app = new Hono();

// Store for request metrics
let requestMetrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  totalLatency: 0,
  cooldowns: 0,
  lastReset: Date.now()
};

function modelEntry(id: string) {
  const dynamicLimit = getContextLength(id);
  return {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'deepseek',
    permission: [],
    root: id,
    parent: null,
    context_length: dynamicLimit,
    max_context_tokens: dynamicLimit,
    max_input_tokens: dynamicLimit,
    max_output_tokens: 8_000,
  };
}

app.use('*', cors());

app.use('*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const authHeader = c.req.header('Authorization');
    const xApiKey = c.req.header('X-API-Key');
    const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : xApiKey;
    if (!providedKey || providedKey !== apiKey) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  await next();
});

// Track request metrics
app.post('/v1/chat/completions', async (c, next) => {
  const startTime = Date.now();
  requestMetrics.totalRequests++;
  
  try {
    await next();
    requestMetrics.successfulRequests++;
    requestMetrics.totalLatency += Date.now() - startTime;
  } catch (error) {
    requestMetrics.failedRequests++;
    throw error;
  }
});

// Basic health check with account stats
app.get('/health', (c) => {
  const stats = browserPool.getAccountStats();
  return c.json({ 
    status: 'ok',
    accounts: stats,
    timestamp: Date.now()
  });
});

// Enhanced Admin panel with full dashboard
app.get('/admin', (c) => {
  const accountStats = browserPool.getAccountStats();
  const telemetryStats = getTelemetryStats();
  const now = Date.now();
  const uptime = now - requestMetrics.lastReset;
  const hours = uptime / (1000 * 60 * 60);
  
  const avgLatency = requestMetrics.successfulRequests > 0 
    ? Math.round(requestMetrics.totalLatency / requestMetrics.successfulRequests) 
    : 0;
  
  const successRate = requestMetrics.totalRequests > 0
    ? ((requestMetrics.successfulRequests / requestMetrics.totalRequests) * 100).toFixed(1)
    : '100.0';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DeepsProxy Admin Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
    .dashboard { max-width: 1400px; margin: 0 auto; }
    h1 { color: white; text-align: center; margin-bottom: 30px; font-size: 2.5em; text-shadow: 2px 2px 4px rgba(0,0,0,0.3); }
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .metric-card { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); transition: transform 0.2s; }
    .metric-card:hover { transform: translateY(-2px); }
    .metric-value { font-size: 2.5em; font-weight: bold; color: #667eea; }
    .metric-label { color: #666; font-size: 14px; margin-top: 5px; }
    .accounts-section { background: white; border-radius: 12px; padding: 25px; margin-bottom: 30px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    .section-title { font-size: 1.5em; color: #333; margin-bottom: 20px; border-bottom: 2px solid #667eea; padding-bottom: 10px; }
    .account-list { display: grid; gap: 15px; }
    .account-item { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 15px; display: flex; justify-content: space-between; align-items: center; }
    .account-info { flex: 1; }
    .account-id { font-weight: bold; color: #333; font-size: 1.1em; }
    .account-status { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; margin-left: 10px; }
    .status-healthy { background: #d4edda; color: #155724; }
    .status-unhealthy { background: #f8d7da; color: #721c24; }
    .status-login_required { background: #fff3cd; color: #856404; }
    .status-suspended { background: #f5c6cb; color: #721c24; }
    .account-actions { display: flex; gap: 8px; }
    .btn { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; transition: all 0.2s; text-decoration: none; display: inline-block; }
    .btn-primary { background: #667eea; color: white; }
    .btn-primary:hover { background: #5568d3; }
    .btn-success { background: #28a745; color: white; }
    .btn-success:hover { background: #218838; }
    .btn-danger { background: #dc3545; color: white; }
    .btn-danger:hover { background: #c82333; }
    .btn-warning { background: #ffc107; color: #333; }
    .btn-warning:hover { background: #e0a800; }
    .btn-secondary { background: #6c757d; color: white; }
    .btn-secondary:hover { background: #5a6268; }
    .add-account-form { background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
    .form-group { margin-bottom: 15px; }
    .form-group label { display: block; margin-bottom: 5px; color: #333; font-weight: 500; }
    .form-group input, .form-group select { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
    .config-section, .logs-section { background: white; border-radius: 12px; padding: 25px; margin-bottom: 30px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    .log-container { background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 8px; font-family: 'Courier New', monospace; font-size: 12px; max-height: 400px; overflow-y: auto; }
    .log-line { margin-bottom: 5px; }
    .log-info { color: #4fc1ff; }
    .log-warn { color: #ffa500; }
    .log-error { color: #f48771; }
    .vnc-iframe { width: 100%; height: 600px; border: 1px solid #ddd; border-radius: 8px; }
    .tabs { display: flex; gap: 10px; margin-bottom: 20px; }
    .tab { padding: 10px 20px; background: #e9ecef; border: none; border-radius: 6px; cursor: pointer; }
    .tab.active { background: #667eea; color: white; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .stat-highlight { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
    .stat-highlight .metric-value { color: white; }
    .stat-highlight .metric-label { color: rgba(255,255,255,0.9); }
  </style>
</head>
<body>
  <div class="dashboard">
    <h1>🚀 DeepsProxy Admin Dashboard</h1>
    
    <!-- Metrics Grid -->
    <div class="metrics-grid">
      <div class="metric-card stat-highlight">
        <div class="metric-value">${accountStats.total}</div>
        <div class="metric-label">Total Accounts</div>
      </div>
      <div class="metric-card">
        <div class="metric-value" style="color: #28a745;">${accountStats.healthy}</div>
        <div class="metric-label">Accounts Logadas</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${requestMetrics.totalRequests}</div>
        <div class="metric-label">Total Requests</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${successRate}%</div>
        <div class="metric-label">Sucesso Médio</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${avgLatency}ms</div>
        <div class="metric-label">Latência Média</div>
      </div>
      <div class="metric-card">
        <div class="metric-value" style="color: #dc3545;">${requestMetrics.cooldowns}</div>
        <div class="metric-label">Cooldowns</div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button class="tab active" onclick="showTab('accounts')">Contas</button>
      <button class="tab" onclick="showTab('config')">Configurações</button>
      <button class="tab" onclick="showTab('logs')">Logs</button>
    </div>

    <!-- Accounts Tab -->
    <div id="accounts-tab" class="tab-content active">
      <div class="accounts-section">
        <h2 class="section-title">Gerenciar Contas</h2>
        
        <!-- Add Account Form -->
        <div class="add-account-form">
          <h3 style="margin-bottom: 15px;">Adicionar Nova Conta</h3>
          <form id="addAccountForm" onsubmit="return addAccount(event)">
            <div class="form-group">
              <label>ID da Conta:</label>
              <input type="text" name="accountId" required placeholder="ex: conta1">
            </div>
            <div class="form-group">
              <label>Path do Perfil:</label>
              <input type="text" name="profilePath" required placeholder="/app/data/profiles/conta1">
            </div>
            <button type="submit" class="btn btn-success">➕ Adicionar Conta</button>
          </form>
        </div>

        <!-- Account List -->
        <div class="account-list">
          ${Object.entries(accountStats.accounts).map(([id, info]: [string, any]) => `
            <div class="account-item">
              <div class="account-info">
                <span class="account-id">${id}</span>
                <span class="account-status status-${info.status || 'unhealthy'}">${info.status || 'unknown'}</span>
                <div style="margin-top: 5px; font-size: 12px; color: #666;">
                  Profile: ${info.profilePath || 'N/A'} | 
                  Last Used: ${info.lastUsed ? new Date(info.lastUsed).toLocaleString() : 'Never'}
                </div>
              </div>
              <div class="account-actions">
                <button class="btn btn-primary" onclick="loginViaVNC('${id}')">🔐 Login VNC</button>
                <button class="btn btn-success" onclick="validateAccount('${id}')">✓ Validar</button>
                <button class="btn btn-warning" onclick="setDefaultAccount('${id}')">⭐ Tornar Padrão</button>
                <button class="btn btn-danger" onclick="removeAccount('${id}')">🗑️ Remover</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>

    <!-- Config Tab -->
    <div id="config-tab" class="tab-content">
      <div class="config-section">
        <h2 class="section-title">Configurações do Sistema</h2>
        <form id="configForm" onsubmit="return updateConfig(event)">
          <div class="form-group">
            <label>API Key:</label>
            <input type="text" name="API_KEY" value="${process.env.API_KEY || ''}" placeholder="Leave empty for no auth">
          </div>
          <div class="form-group">
            <label>Port:</label>
            <input type="number" name="PORT" value="${process.env.PORT || '4000'}">
          </div>
          <div class="form-group">
            <label>Playwright Headless:</label>
            <select name="PLAYWRIGHT_HEADLESS">
              <option value="true" ${process.env.PLAYWRIGHT_HEADLESS !== 'false' ? 'selected' : ''}>true</option>
              <option value="false" ${process.env.PLAYWRIGHT_HEADLESS === 'false' ? 'selected' : ''}>false</option>
            </select>
          </div>
          <div class="form-group">
            <label>Log Level:</label>
            <select name="LOG_LEVEL">
              <option value="debug" ${process.env.LOG_LEVEL === 'debug' ? 'selected' : ''}>debug</option>
              <option value="info" ${process.env.LOG_LEVEL === 'info' || !process.env.LOG_LEVEL ? 'selected' : ''}>info</option>
              <option value="warn" ${process.env.LOG_LEVEL === 'warn' ? 'selected' : ''}>warn</option>
              <option value="error" ${process.env.LOG_LEVEL === 'error' ? 'selected' : ''}>error</option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary">💾 Salvar e Reiniciar</button>
        </form>
      </div>
    </div>

    <!-- Logs Tab -->
    <div id="logs-tab" class="tab-content">
      <div class="logs-section">
        <h2 class="section-title">Logs em Tempo Real</h2>
        <div class="log-container" id="logContainer">
          <div class="log-line log-info">[INFO] Aguardando logs...</div>
        </div>
        <button class="btn btn-secondary" style="margin-top: 15px;" onclick="loadLogs()">🔄 Atualizar Logs</button>
      </div>
    </div>
  </div>

  <script>
    // Auto-detect current host for VNC URL
    const currentHost = window.location.host;
    
    function showTab(tabName) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      event.target.classList.add('active');
      document.getElementById(tabName + '-tab').classList.add('active');
    }

    async function addAccount(e) {
      e.preventDefault();
      const form = e.target;
      const data = {
        accountId: form.accountId.value,
        profilePath: form.profilePath.value
      };
      
      try {
        const response = await fetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const result = await response.json();
        if (response.ok) {
          alert('Conta adicionada com sucesso!');
          location.reload();
        } else {
          alert('Erro: ' + result.error);
        }
      } catch (error) {
        alert('Erro ao adicionar conta: ' + error.message);
      }
      return false;
    }

    async function loginViaVNC(accountId) {
      // Set headless to false and restart browser for this account
      try {
        const response = await fetch('/api/accounts/' + accountId + '/login-vnc', {
          method: 'POST'
        });
        if (response.ok) {
          // Open VNC in new window
          const vncUrl = 'http://' + currentHost.replace(':4000', ':6081') + '/vnc.html';
          window.open(vncUrl, '_blank');
          alert('VNC aberto! Faça o login manualmente na conta ' + accountId);
        } else {
          alert('Erro ao iniciar login VNC');
        }
      } catch (error) {
        alert('Erro: ' + error.message);
      }
    }

    async function validateAccount(accountId) {
      try {
        const response = await fetch('/api/accounts/' + accountId + '/validate', {
          method: 'POST'
        });
        if (response.ok) {
          alert('Conta validada com sucesso!');
          location.reload();
        } else {
          const result = await response.json();
          alert('Erro: ' + result.error);
        }
      } catch (error) {
        alert('Erro ao validar: ' + error.message);
      }
    }

    async function setDefaultAccount(accountId) {
      try {
        const response = await fetch('/api/accounts/' + accountId + '/default', {
          method: 'POST'
        });
        if (response.ok) {
          alert('Conta definida como padrão!');
        } else {
          alert('Erro ao definir conta padrão');
        }
      } catch (error) {
        alert('Erro: ' + error.message);
      }
    }

    async function removeAccount(accountId) {
      if (!confirm('Tem certeza que deseja remover a conta ' + accountId + '?')) return;
      
      try {
        const response = await fetch('/api/accounts/' + accountId, {
          method: 'DELETE'
        });
        if (response.ok) {
          alert('Conta removida com sucesso!');
          location.reload();
        } else {
          alert('Erro ao remover conta');
        }
      } catch (error) {
        alert('Erro: ' + error.message);
      }
    }

    async function updateConfig(e) {
      e.preventDefault();
      if (!confirm('Isso irá reiniciar o container. Continuar?')) return false;
      
      const form = e.target;
      const config = {
        API_KEY: form.API_KEY.value,
        PORT: form.PORT.value,
        PLAYWRIGHT_HEADLESS: form.PLAYWRIGHT_HEADLESS.value,
        LOG_LEVEL: form.LOG_LEVEL.value
      };
      
      try {
        const response = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });
        if (response.ok) {
          alert('Configuração salva! O container será reiniciado...');
        } else {
          alert('Erro ao salvar configuração');
        }
      } catch (error) {
        alert('Erro: ' + error.message);
      }
      return false;
    }

    async function loadLogs() {
      try {
        const response = await fetch('/api/logs');
        const logs = await response.text();
        const container = document.getElementById('logContainer');
        container.innerHTML = logs.split('\\n').map(line => {
          let className = 'log-info';
          if (line.includes('ERROR') || line.includes('error')) className = 'log-error';
          else if (line.includes('WARN') || line.includes('warn')) className = 'log-warn';
          return '<div class="log-line ' + className + '">' + line + '</div>';
        }).join('');
        container.scrollTop = container.scrollHeight;
      } catch (error) {
        console.error('Erro ao carregar logs:', error);
      }
    }

    // Auto-refresh logs every 5 seconds
    setInterval(loadLogs, 5000);
    loadLogs();
  </script>
</body>
</html>
  `;
  return c.html(html);
});

// API Routes for admin panel
app.post('/api/accounts', async (c) => {
  try {
    const { accountId, profilePath } = await c.req.json();
    if (!accountId || !profilePath) {
      return c.json({ error: 'accountId and profilePath are required' }, 400);
    }
    
    await addAccount(accountId, profilePath);
    return c.json({ success: true, message: 'Account added successfully' });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.delete('/api/accounts/:accountId', async (c) => {
  try {
    const accountId = c.req.param('accountId');
    await removeAccount(accountId);
    return c.json({ success: true, message: 'Account removed successfully' });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/accounts/:accountId/validate', async (c) => {
  try {
    const accountId = c.req.param('accountId');
    await validateAccount(accountId);
    return c.json({ success: true, message: 'Account validated successfully' });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/accounts/:accountId/default', async (c) => {
  try {
    const accountId = c.req.param('accountId');
    await setAccountAsDefault(accountId);
    return c.json({ success: true, message: 'Account set as default' });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/accounts/:accountId/login-vnc', async (c) => {
  try {
    const accountId = c.req.param('accountId');
    // Set headless to false for VNC login
    process.env.PLAYWRIGHT_HEADLESS = 'false';
    // Close and reopen the account browser with headless=false
    await removeAccount(accountId);
    await addAccount(accountId, `/app/data/profiles/${accountId}`);
    return c.json({ success: true, message: 'VNC login mode enabled' });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/config', async (c) => {
  try {
    const config = await c.req.json();
    const envPath = path.resolve('/app/data/.env');
    
    // Read existing .env or create new one
    let envContent = '';
    try {
      envContent = fs.readFileSync(envPath, 'utf-8');
    } catch (e) {
      // File doesn't exist, will create new one
    }
    
    // Update values
    const lines = envContent.split('\n');
    const updatedLines: string[] = [];
    const updatedKeys = new Set<string>();
    
    for (const line of lines) {
      const [key] = line.split('=');
      if (key && config.hasOwnProperty(key)) {
        updatedLines.push(`${key}=${config[key]}`);
        updatedKeys.add(key);
      } else if (line.trim()) {
        updatedLines.push(line);
      }
    }
    
    // Add new keys
    for (const [key, value] of Object.entries(config)) {
      if (!updatedKeys.has(key)) {
        updatedLines.push(`${key}=${value}`);
      }
    }
    
    // Write updated .env
    fs.writeFileSync(envPath, updatedLines.join('\n'));
    
    // Schedule container restart (in real implementation, this would signal docker-compose)
    setTimeout(() => {
      console.log('[Config] Restarting application with new config...');
      process.exit(0);
    }, 2000);
    
    return c.json({ success: true, message: 'Configuration saved' });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/logs', async (c) => {
  try {
    const logPath = path.resolve('/app/data/deepsproxy.log');
    let logs = '';
    try {
      logs = fs.readFileSync(logPath, 'utf-8');
    } catch (e) {
      logs = '[INFO] No logs available yet.';
    }
    return c.text(logs);
  } catch (error: any) {
    return c.text('Error reading logs: ' + error.message);
  }
});

// VNC static files proxy (served by nginx in container)
app.get('/vnc.html', (c) => {
  return c.html(`
<!DOCTYPE html>
<html>
<head>
  <title>VNC Console</title>
  <meta http-equiv="refresh" content="0;url=http://localhost:6080/vnc.html">
</head>
<body>
  <p>Redirecting to VNC console...</p>
  <p>If not redirected, <a href="http://localhost:6080/vnc.html">click here</a></p>
</body>
</html>
  `);
});

// VNC static files proxy (served by nginx in container)
app.get('/vnc.html', (c) => {
  return c.html(`
<!DOCTYPE html>
<html>
<head>
  <title>VNC Console</title>
  <meta http-equiv="refresh" content="0;url=http://localhost:6080/vnc.html">
</head>
<body>
  <p>Redirecting to VNC console...</p>
  <p>If not redirected, <a href="http://localhost:6080/vnc.html">click here</a></p>
</body>
</html>
  `);
});

// OpenAI compatible routes
app.post('/v1/chat/completions', chatCompletions);

app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: [
      modelEntry('deepseek-v4-flash'),
      modelEntry('deepseek-v4-flash-thinking'),
      modelEntry('deepseek-v4-pro'),
      modelEntry('deepseek-v4-pro-thinking')
    ]
  });
});

// Initialize playwright with multi-account support when server starts
import { fileURLToPath } from 'url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Parse account configurations from environment
  const parseAccountConfigs = () => {
    const accountStr = process.env.DEEPSEEK_ACCOUNTS || '';
    if (!accountStr.trim()) {
      // Fallback to single default account
      return [{
        id: 'default',
        profilePath: path.resolve('deepseek_profile'),
        email: undefined
      }];
    }

    const configs: Array<{ id: string; profilePath: string; email?: string }> = [];
    const accounts = accountStr.split(';').filter(s => s.trim());
    
    for (const account of accounts) {
      const parts = account.split(',');
      const [id, profilePath, email] = parts;
      
      if (!id || !profilePath) {
        console.warn(`[Config] Invalid account format: ${account}. Skipping.`);
        continue;
      }

      configs.push({
        id: id.trim(),
        profilePath: path.resolve(profilePath.trim()),
        email: email?.trim()
      });
    }

    return configs.length > 0 ? configs : [{
      id: 'default',
      profilePath: path.resolve('deepseek_profile'),
      email: undefined
    }];
  };

  const accountConfigs = parseAccountConfigs();
  console.log(`[Server] Initializing ${accountConfigs.length} DeepSeek account(s)...`);

  browserPool.initialize(accountConfigs).then(() => {
    const stats = browserPool.getAccountStats();
    console.log(`[Server] Playwright initialized. Accounts: ${stats.total} total, ${stats.healthy} healthy`);
    
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    console.log(`Server is running on port ${port}`);

    serve({
      fetch: app.fetch,
      port
    });
  }).catch((err: any) => {
    console.error('Failed to initialize playwright:', err);
    process.exit(1);
  });

  // Graceful shutdown
  const gracefulShutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
    try {
      await closePlaywright();
      console.log('[Server] Playwright closed.');
      process.exit(0);
    } catch (err) {
      console.error('[Server] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
