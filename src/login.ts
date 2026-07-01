/*
 * File: login.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { browserPool, closePlaywright, getDeepSeekHeaders } from './services/playwright.ts';

async function main() {
  const accountId = process.env.DEEPSEEK_ACCOUNT_ID || 'default';
  const profilePath = process.env.DEEPSEEK_PROFILE_PATH || '/app/deepseek_profile';
  
  console.log(`Initializing browser for account ${accountId}...`);
  await browserPool.initialize([{ id: accountId, profilePath }]);
  
  const page = await browserPool.getPageForAccount(accountId);
  if (!page) {
    console.error('Failed to get page for account');
    process.exit(1);
  }
  
  console.log('Browser opened. Please login to chat.deepseek.com.');
  console.log('Once you are fully logged in and can see the chat interface, close the browser window or press Ctrl+C here.');
  
  // Wait indefinitely until user closes the process
  process.on('SIGINT', async () => {
    console.log('Closing browser...');
    await closePlaywright();
    process.exit(0);
  });
}

main();