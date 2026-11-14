/**
 * Test-only signal delivery for an owned official CLI process. Windows
 * child.kill() terminates the process without running its disposal hooks.
 * The private parent IPC asks the CLI's existing SIGTERM handler to run once.
 */
import { pathToFileURL } from 'node:url';

const [bin, ...args] = process.argv.slice(2);
if (!bin || !process.send) throw new Error('The CLI signal harness requires its parent IPC and an explicit CLI');
process.argv = [process.execPath, bin, ...args];
process.once('message', message => {
  if (message?.type !== 'test-owned-cli-stop') throw new Error('Unexpected CLI harness message');
  if (process.listenerCount('SIGTERM') === 0) throw new Error('The official CLI has no graceful shutdown handler');
  process.emit('SIGTERM');
});
const { runCli } = await import(pathToFileURL(bin).href);
if (typeof runCli !== 'function') throw new Error('The official CLI does not expose its runCli entry');
await runCli();
