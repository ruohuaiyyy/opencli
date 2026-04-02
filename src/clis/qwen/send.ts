import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { QWEN_DOMAIN, sendQwenMessage } from './utils.js';

export const sendCommand = cli({
  site: 'qwen',
  name: 'send',
  description: 'Send a message to Qwen web chat',
  domain: QWEN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'text', required: true, positional: true, help: 'Message to send' },
  ],
  columns: ['Status', 'SubmittedBy', 'InjectedText'],
  func: async (page: IPage, kwargs: any) => {
    const text = kwargs.text as string;
    const submittedBy = await sendQwenMessage(page, text);

    return [{
      Status: 'Success',
      SubmittedBy: submittedBy,
      InjectedText: text,
    }];
  },
});