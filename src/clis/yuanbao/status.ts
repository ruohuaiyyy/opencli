import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { YUANBAO_DOMAIN, YUANBAO_CHAT_URL, getYuanbaoPageState } from './utils.js';

export const statusCommand = cli({
  site: 'yuanbao',
  name: 'status',
  description: 'Check Yuanbao chat page availability and login state',
  domain: YUANBAO_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [],
  columns: ['Status', 'Login', 'Url', 'Title'],
  func: async (page: IPage) => {
    const state = await getYuanbaoPageState(page);
    const loggedIn = state.isLogin === null ? 'Unknown' : state.isLogin ? 'Yes' : 'No';
    const status = state.isLogin === false ? 'Login Required' : 'Connected';

    return [{
      Status: status,
      Login: loggedIn,
      Url: state.url,
      Title: state.title || 'Yuanbao',
    }];
  },
});
