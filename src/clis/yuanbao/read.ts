import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { YUANBAO_DOMAIN, getYuanbaoVisibleTurns } from './utils.js';

export const readCommand = cli({
  site: 'yuanbao',
  name: 'read',
  description: 'Read the current Yuanbao conversation history',
  domain: YUANBAO_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [],
  columns: ['Role', 'Text'],
  func: async (page: IPage) => {
    const turns = await getYuanbaoVisibleTurns(page);
    if (turns.length > 0) return turns;
    return [{ Role: 'System', Text: 'No visible Yuanbao messages were found.' }];
  },
});
