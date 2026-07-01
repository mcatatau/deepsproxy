/*
 * File: playwright.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { chromium, BrowserContext, Page, Browser } from 'playwright';
import path from 'path';

// Multi-account support with browser pool
export interface DeepSeekAccount {
  id: string;
  profilePath: string;
  email?: string;
  status: AccountStatus;
  lastHealthCheck?: number;
  consecutiveFailures: number;
  context?: BrowserContext;
  page?: Page;
}

export type AccountStatus = 'healthy' | 'login_required' | 'suspended' | 'unhealthy' | 'initializing';

// PoW header cache to reduce browser calls
interface CachedHeaders {
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: number | null;
  timestamp: number;
  accountId: string;
}

const HEADER_CACHE_TTL_MS = Number(process.env.DEEPSPROXY_POW_CACHE_TTL_MS || '30000'); // 30s default
const headerCache = new Map<string, CachedHeaders>(); // Keyed by accountId

// Browser pool management
class BrowserPool {
  private accounts: Map<string, DeepSeekAccount> = new Map();
  private locks: Map<string, Promise<void>> = new Map();
  private browserInstance: Browser | null = null;
  private healthCheckInterval?: NodeJS.Timeout;

  async initialize(accountConfigs: Array<{ id: string; profilePath: string; email?: string }>): Promise<void> {
    // Launch single browser instance for all accounts
    this.browserInstance = await chromium.launch({
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--exclude-switches=enable-automation',
        '--disable-infobars',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    // Initialize each account with its own context
    for (const config of accountConfigs) {
      const account: DeepSeekAccount = {
        ...config,
        status: 'initializing',
        consecutiveFailures: 0,
      };
      
      try {
        account.context = await this.browserInstance.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        });
        account.page = await account.context.newPage();
        account.status = 'healthy';
        this.accounts.set(config.id, account);
        console.log(`[BrowserPool] Initialized account ${config.id} with profile ${config.profilePath}`);
      } catch (error: any) {
        account.status = 'unhealthy';
        this.accounts.set(config.id, account);
        console.error(`[BrowserPool] Failed to initialize account ${config.id}:`, error.message);
      }
    }

    // Start health check interval
    const healthCheckIntervalMs = Number(process.env.DEEPSPROXY_HEALTH_CHECK_INTERVAL_MS || '60000');
    this.healthCheckInterval = setInterval(() => this.runHealthChecks(), healthCheckIntervalMs);
  }

  private async withLock<T>(accountId: string, fn: () => T): Promise<T> {
    let lock = this.locks.get(accountId);
    if (!lock) lock = Promise.resolve();

    let resolveLock: () => void;
    const newLock = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    this.locks.set(accountId, newLock);
    await lock;

    try {
      return fn();
    } finally {
      resolveLock!();
    }
  }

  async getHealthyAccount(): Promise<DeepSeekAccount | null> {
    const healthyAccounts = Array.from(this.accounts.values()).filter(
      acc => acc.status === 'healthy' && acc.page !== undefined
    );

    if (healthyAccounts.length === 0) return null;

    // Simple round-robin: pick the one with least consecutive failures
    healthyAccounts.sort((a, b) => a.consecutiveFailures - b.consecutiveFailures);
    return healthyAccounts[0];
  }

  async getPageForAccount(accountId: string): Promise<Page | null> {
    const account = this.accounts.get(accountId);
    if (!account || !account.page) return null;
    return account.page;
  }

  async updateAccountStatus(accountId: string, status: AccountStatus, isError?: boolean): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;

    account.status = status;
    account.lastHealthCheck = Date.now();

    if (isError) {
      account.consecutiveFailures++;
    } else {
      account.consecutiveFailures = 0;
    }
  }

  private async runHealthChecks(): Promise<void> {
    for (const [id, account] of this.accounts) {
      if (!account.page || account.status === 'initializing') continue;

      try {
        const currentUrl = account.page.url();
        const isOnDeepSeek = currentUrl.includes('chat.deepseek.com');
        
        if (!isOnDeepSeek) {
          await account.page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        }

        const chatInputTimeoutMs = Number(process.env.DEEPSPROXY_CHAT_INPUT_TIMEOUT_MS || '8000');
        const hasInput = await account.page.waitForSelector('textarea, [role="textbox"], [contenteditable="true"]', { timeout: chatInputTimeoutMs })
          .then(() => true)
          .catch(() => false);

        if (hasInput) {
          await this.updateAccountStatus(id, 'healthy', false);
        } else {
          const pageState = await account.page.evaluate(() => {
            const fullBodyText = document.body?.innerText || '';
            return {
              suspended: /suspended until|violation of user policies|account has been suspended/i.test(fullBodyText),
              loginRequired: /log in|login|sign in|entrar/i.test(fullBodyText),
            };
          });

          if (pageState.suspended) {
            await this.updateAccountStatus(id, 'suspended', true);
            console.warn(`[BrowserPool] Account ${id} is suspended`);
          } else if (pageState.loginRequired) {
            await this.updateAccountStatus(id, 'login_required', true);
            console.warn(`[BrowserPool] Account ${id} requires login`);
          } else {
            await this.updateAccountStatus(id, 'unhealthy', true);
          }
        }
      } catch (error: any) {
        await this.updateAccountStatus(id, 'unhealthy', true);
        console.warn(`[BrowserPool] Health check failed for account ${id}:`, error.message);
      }
    }
  }

  async close(): Promise<void> {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    if (this.browserInstance) await this.browserInstance.close();
    this.accounts.clear();
  }

  getAccountStats(): { total: number; healthy: number; unhealthy: number; suspended: number } {
    const stats = { total: 0, healthy: 0, unhealthy: 0, suspended: 0 };
    for (const acc of this.accounts.values()) {
      stats.total++;
      if (acc.status === 'healthy') stats.healthy++;
      else if (acc.status === 'suspended') stats.suspended++;
      else stats.unhealthy++;
    }
    return stats;
  }
}

export const browserPool = new BrowserPool();

/**
 * Ensures the session is valid and extracts headers, PoW, and session ID.
 */
export async function getDeepSeekHeaders(
  forceNew = false,
  accountId?: string
): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: number | null }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const mockSessionId = process.env.TEST_SESSION_ID || 'mock-session';
    return { headers: { authorization: 'Bearer MOCK' }, chatSessionId: mockSessionId, parentMessageId: null };
  }

  // Get or select account
  let account: DeepSeekAccount | null = null;
  
  if (accountId) {
    account = Array.from(browserPool['accounts'].values()).find(acc => acc.id === accountId) || null;
  } else {
    account = await browserPool.getHealthyAccount();
  }

  if (!account || !account.page) {
    throw new Error('No healthy Playwright account available');
  }

  const activePage = account.page;

  // Navigate to deepseek chat. If forceNew is true or we're not on deepseek, go to home page.
  const currentUrl = activePage.url();
  const isOnDeepSeek = currentUrl.includes('chat.deepseek.com');
  const isOnSpecificChat = isOnDeepSeek && /\/chat\/\d+/.test(currentUrl);

  if (!isOnDeepSeek || forceNew || isOnSpecificChat) {
    await activePage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
  }

  // Wait for the chat input. Keep this timeout short: when DeepSeek shows an
  // account/login/suspension banner there is no input, and retrying the same
  // browser state just makes OpenAI clients look hung.
  const chatInputSelector = 'textarea, [role="textbox"], [contenteditable="true"]';
  const chatInputTimeoutMs = Number(process.env.DEEPSPROXY_CHAT_INPUT_TIMEOUT_MS || '8000');
  await activePage.waitForSelector(chatInputSelector, { timeout: chatInputTimeoutMs }).catch(async () => {
    const pageState = await activePage.evaluate(() => {
      const fullBodyText = document.body?.innerText || '';
      const bodyText = fullBodyText.slice(0, 5000);
      const suspensionMatch = fullBodyText.match(/Due to violation of user policies, your account has been suspended until\s+([^\.\\n]+)\.\s*If you have any questions, please Contact us\./i);
      const suspendedUntil = suspensionMatch?.[1]?.trim() || null;
      const suspensionOriginal = suspensionMatch?.[0]?.trim() || null;
      return {
        url: location.href,
        title: document.title,
        bodyText,
        textareaCount: document.querySelectorAll('textarea').length,
        inputCount: document.querySelectorAll('input, textarea, [role="textbox"], [contenteditable]').length,
        suspended: /suspended until|violation of user policies|account has been suspended/i.test(fullBodyText),
        suspendedUntil,
        suspensionOriginal,
        loginRequired: /log in|login|sign in|entrar/i.test(fullBodyText),
      };
    }).catch((e: any) => ({ evaluateError: e?.message || String(e) }));

    const state: any = pageState;
    
    // Update account status based on error
    if (state?.suspended) {
      await browserPool.updateAccountStatus(account!.id, 'suspended', true);
      const until = typeof state.suspendedUntil === 'string' && state.suspendedUntil.trim() ? state.suspendedUntil.trim() : '';
      const original = typeof state.suspensionOriginal === 'string' && state.suspensionOriginal.trim() ? state.suspensionOriginal.trim() : '';
      const detail = original || (until ? `Due to violation of user policies, your account has been suspended until ${until}.` : 'DeepSeek reported an account suspension.');
      throw new Error(`DeepSeek account is suspended; chat input is unavailable. Original DeepSeek message: ${detail}`);
    }
    if (state?.loginRequired) {
      await browserPool.updateAccountStatus(account!.id, 'login_required', true);
      throw new Error('DeepSeek login is required; chat input is unavailable.');
    }
    await browserPool.updateAccountStatus(account!.id, 'unhealthy', true);
    throw new Error('DeepSeek chat input unavailable; page did not expose an input box.');
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for PoW headers')), 30000);

    const routeHandler = async (route: any, request: any) => {
      clearTimeout(timeout);
      
      const reqHeaders = request.headers();
      let uiSessionId = '';
      let uiParentMessageId: number | null = null;

      const postData = request.postData();
      if (postData) {
        try {
          const payload = JSON.parse(postData);
          if (payload.chat_session_id) {
            uiSessionId = payload.chat_session_id;
          }
          if (payload.parent_message_id !== undefined) {
            uiParentMessageId = payload.parent_message_id;
          }
        } catch (e) {
          // ignore parsing error
        }
      }

      const extractedHeaders = {
        'x-ds-pow-response': reqHeaders['x-ds-pow-response'] || '',
        'x-hif-dliq': reqHeaders['x-hif-dliq'] || '',
        'x-hif-leim': reqHeaders['x-hif-leim'] || '',
        'authorization': reqHeaders['authorization'] || '',
        'cookie': reqHeaders['cookie'] || ''
      };

      // Cache headers for this account
      headerCache.set(account!.id, {
        headers: extractedHeaders,
        chatSessionId: uiSessionId,
        parentMessageId: uiParentMessageId,
        timestamp: Date.now(),
        accountId: account!.id
      });

      // Abort to prevent polluting chat history
      await route.abort('aborted');
      
      // Cleanup route
      await activePage.unroute('**/api/v0/chat/completion', routeHandler);

      resolve({ headers: extractedHeaders, chatSessionId: uiSessionId, parentMessageId: uiParentMessageId });
    };

    activePage.route('**/api/v0/chat/completion', routeHandler).then(() => {
      // Trigger PoW generation by typing and hitting enter
      activePage.fill('textarea', 'a').then(() => {
        activePage.keyboard.press('Enter');
      });
    });
  });
}

export async function closePlaywright() {
  await browserPool.close();
}
