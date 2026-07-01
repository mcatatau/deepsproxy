/*
 * File: deepseek.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { getDeepSeekHeaders } from './playwright.ts';

// Thread-safe session state tracking with per-session locks
class SessionStateStore {
  private states: Map<string, number | null> = new Map();
  private locks: Map<string, Promise<void>> = new Map();

  constructor() {
    // Initialize from globalThis if available (for hot-reload survival)
    const existing = (globalThis as any)._sessionStates;
    if (existing && existing instanceof Map) {
      this.states = existing;
    } else {
      (globalThis as any)._sessionStates = this.states;
    }
  }

  private async withLock<T>(sessionId: string, fn: () => T): Promise<T> {
    let lock = this.locks.get(sessionId);
    
    if (!lock) {
      lock = Promise.resolve();
    }

    let resolveLock: () => void;
    const newLock = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    this.locks.set(sessionId, newLock);
    await lock;

    try {
      return fn();
    } finally {
      resolveLock!();
    }
  }

  async update(sessionId: string, parentId: number | null): Promise<void> {
    if (!sessionId) return;
    
    await this.withLock(sessionId, () => {
      this.states.set(sessionId, parentId);
    });
  }

  get(sessionId: string): number | null | undefined {
    return this.states.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.states.has(sessionId);
  }
}

export const sessionStateStore = new SessionStateStore();

export function updateSessionParent(sessionId: string, parentId: number | null): Promise<void> {
  return sessionStateStore.update(sessionId, parentId);
}

export interface DeepSeekPayload {
  chat_session_id?: string;
  parent_message_id?: number | null;
  model_type: string | null;
  prompt: string;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  preempt: boolean;
}

export async function createDeepSeekStream(
  prompt: string,
  enableThinking: boolean,
  isProModel: boolean = false,
  forcedParentId?: number | null
): Promise<{ stream: ReadableStream, headers: Record<string, string>, uiSessionId: string }> {
  // Obtain fresh headers/PoW from Playwright
  // If forcedParentId is null, it means we are explicitly starting a new session
  const { headers, chatSessionId, parentMessageId } = await getDeepSeekHeaders(forcedParentId === null);

  // Determine the actual parent ID:
  // 1. If forcedParentId is provided (even if null), use it.
  // 2. If tracked parent ID is available for this session, use it.
  // 3. Fallback to Playwright's state.
  let actualParentId: number | null = parentMessageId;
  
  if (forcedParentId !== undefined) {
    actualParentId = forcedParentId;
  } else if (chatSessionId && sessionStateStore.has(chatSessionId)) {
    const storedParentId = sessionStateStore.get(chatSessionId);
    if (storedParentId !== undefined) {
      actualParentId = storedParentId;
    }
  }

  const payload: DeepSeekPayload = {
    chat_session_id: chatSessionId || undefined,
    parent_message_id: actualParentId,
    model_type: isProModel ? 'expert' : null,
    prompt: prompt,
    ref_file_ids: [],
    thinking_enabled: enableThinking,
    search_enabled: true,
    preempt: false
  };

  const response = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'authorization': headers['authorization'],
      'content-type': 'application/json',
      'origin': 'https://chat.deepseek.com',
      'x-ds-pow-response': headers['x-ds-pow-response'],
      'x-hif-dliq': headers['x-hif-dliq'],
      'x-hif-leim': headers['x-hif-leim'],
      'x-app-version': '2.0.0',
      'x-client-locale': 'pt_BR',
      'x-client-platform': 'web',
      'x-client-version': '2.0.0'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Failed to fetch from DeepSeek: ${response.status} ${response.statusText} - ${errText}`);
  }

  return { stream: response.body, headers, uiSessionId: chatSessionId };
}
