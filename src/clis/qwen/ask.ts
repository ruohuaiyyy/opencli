import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { QWEN_DOMAIN, getQwenTranscriptLines, sendQwenMessage, waitForQwenResponse } from './utils.js';

export const askCommand = cli({
  site: 'qwen',
  name: 'ask',
  description: 'Send a prompt and wait for the Qwen response',
  domain: QWEN_DOMAIN,
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

    const beforeLines = await getQwenTranscriptLines(page);

    await sendQwenMessage(page, text);
    const response = await waitForQwenResponse(page, beforeLines, text, timeout);

    if (!response) {
      return [
        { Role: 'User', Text: text },
        { Role: 'System', Text: `No response within ${timeout}s. Qwen may still be generating.` },
      ];
    }

    return [
      { Role: 'User', Text: text },
      { Role: 'Assistant', Text: response },
    ];
  },
});