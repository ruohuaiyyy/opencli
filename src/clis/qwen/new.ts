import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { QWEN_DOMAIN, QWEN_CHAT_URL, startNewQwenChat } from './utils.js';

export const newCommand = cli({
  site: 'qwen',
  name: 'new',
  description: 'Start a new conversation in Qwen web chat',
  domain: QWEN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [],
  columns: ['Status', 'Action'],
  func: async (page: IPage) => {
    const action = await startNewQwenChat(page);
    return [{
      Status: 'Success',
      Action: action === 'navigate' ? 'Reloaded /chat as fallback' : `Clicked ${action}`,
    }];
  },
});