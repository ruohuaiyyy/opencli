import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { QWEN_DOMAIN, getQwenTranscriptLines } from './utils.js';

export const readCommand = cli({
  site: 'qwen',
  name: 'read',
  description: 'Read the current Qwen conversation history',
  domain: QWEN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [],
  columns: ['Role', 'Text'],
  func: async (page: IPage) => {
    const lines = await getQwenTranscriptLines(page);
    if (lines.length > 0) {
      return lines.map(line => ({ Role: 'Assistant', Text: line }));
    }
    return [{ Role: 'System', Text: 'No visible Qwen messages were found.' }];
  },
});