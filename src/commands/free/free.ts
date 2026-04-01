import { v4 as uuidv4 } from 'uuid';
import net from 'net';
import type { LocalCommandCall } from '../../types/command.js';

function getFreePort(): Promise<number> {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });
}

let isRunning = false;

export const call: LocalCommandCall = async (args, context) => {
    if (isRunning) {
        return { type: 'text', value: `🚀 Free AI channel is already enabled and active!` };
    }
    
    const port = await getFreePort();
    const token = uuidv4();
    
    // Dynamically import the embedded cursor2api proxy
    const { startCursor2ApiProxy } = await import('../../vendor/cursor2api/src/index.js');
    await startCursor2ApiProxy(port, token);
    
    // Override the environment variables used by the rest of the application
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.ANTHROPIC_API_KEY = token;
    
    // Enforce models according to requirements
    process.env.CURSOR_MODEL = 'anthropic/claude-sonnet-4.6';

    isRunning = true;
    
    return {
      type: 'text',
      value: `🚀 Free AI channel enabled successfully!`,
    };
};
