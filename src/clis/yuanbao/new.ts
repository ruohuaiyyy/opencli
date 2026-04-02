import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { YUANBAO_DOMAIN, YUANBAO_CHAT_URL, startNewYuanbaoChat } from './utils.js';

export const newCommand = cli({
  site: 'yuanbao',
  name: 'new',
  description: 'Start a new conversation in Yuanbao web chat',
  domain: YUANBAO_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [],
  columns: ['Status', 'Action'],
  func: async (page: IPage) => {
    const action = await startNewYuanbaoChat(page);
    return [{
      Status: 'Success',
      Action: action === 'navigate' ? 'Reloaded /chat as fallback' : `Clicked ${action}`,
    }];
  },
});
