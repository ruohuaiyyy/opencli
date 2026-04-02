import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { YUANBAO_DOMAIN, getYuanbaoTranscriptLines, getYuanbaoVisibleTurns, sendYuanbaoMessage, waitForYuanbaoResponse } from './utils.js';

export const askCommand = cli({
  site: 'yuanbao',
  name: 'ask',
  description: 'Send a prompt and wait for the Yuanbao response',
  domain: YUANBAO_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  timeoutSeconds: 180,
  args: [
    { name: 'text', required: true, positional: true, help: 'Prompt to send' },
    { name: 'timeout', required: false, help: 'Max seconds to wait (default: 60)', default: '60' },
  ],
  columns: ['Role', 'Text'],
  func: async (page: IPage, kwargs: any) => {
    const text = kwargs.text as string;
    const timeout = parseInt(kwargs.timeout as string, 10) || 60;
    const beforeTurns = await getYuanbaoVisibleTurns(page);
    const beforeLines = await getYuanbaoTranscriptLines(page);

    await sendYuanbaoMessage(page, text);
    const response = await waitForYuanbaoResponse(page, beforeLines, beforeTurns, text, timeout);

    if (!response) {
      return [
        { Role: 'User', Text: text },
        { Role: 'System', Text: `No response within ${timeout}s. Yuanbao may still be generating.` },
      ];
    }

    return [
      { Role: 'User', Text: text },
      { Role: 'Assistant', Text: response },
    ];
  },
});
