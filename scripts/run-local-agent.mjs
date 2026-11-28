import { initLocalDb } from '../src/lib/db/client.ts';
import { startAgentServer, stopAgentServer } from '../src/lib/local/agent-server/index.ts';
await initLocalDb(); await startAgentServer();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await stopAgentServer(); process.exit(0); });
