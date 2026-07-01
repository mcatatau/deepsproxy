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
import { browserPool, closePlaywright } from './services/playwright.ts';
import { getContextLength } from './services/telemetry.ts';
import path from 'path';

dotenv.config();

export const app = new Hono();

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

// Basic health check with account stats
app.get('/health', (c) => {
  const stats = browserPool.getAccountStats();
  return c.json({ 
    status: 'ok',
    accounts: stats,
    timestamp: Date.now()
  });
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
