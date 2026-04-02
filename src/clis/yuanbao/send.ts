import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { YUANBAO_DOMAIN, sendYuanbaoMessage } from './utils.js';

export const sendCommand = cli({
  site: 'yuanbao',
  name: 'send',
  description: 'Send a message to Yuanbao web chat',
  domain: YUANBAO_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [{ name: 'text', required: true, positional: true, help: 'Message to send' }],
  columns: ['Status', 'SubmittedBy', 'InjectedText'],
  func: async (page: IPage, kwargs: any) => {
    const text = kwargs.text as string;
    const submittedBy = await sendYuanbaoMessage(page, text);

    return [{
      Status: 'Success',
      SubmittedBy: submittedBy,
      InjectedText: text,
    }];
  },
});
