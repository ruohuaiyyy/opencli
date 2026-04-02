import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { QWEN_DOMAIN, QWEN_CHAT_URL, getQwenPageState } from './utils.js';

export const statusCommand = cli({
  site: 'qwen',
  name: 'status',
  description: 'Check Qwen chat page availability and login state',
  domain: QWEN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [],
  columns: ['Status', 'Login', 'Url', 'Title'],
  func: async (page: IPage) => {
    const state = await getQwenPageState(page);
    const loggedIn = state.isLogin === null ? 'Unknown' : state.isLogin ? 'Yes' : 'No';
    const status = state.isLogin === false ? 'Login Required' : 'Connected';

    return [{
      Status: status,
      Login: loggedIn,
      Url: state.url,
      Title: state.title || 'Qwen',
    }];
  },
});