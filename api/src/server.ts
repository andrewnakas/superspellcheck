import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { AccountStore } from './db.ts';

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp({ accounts: new AccountStore() }).fetch, port }, () => console.log(`superspellcheck api listening on :${port}`));
