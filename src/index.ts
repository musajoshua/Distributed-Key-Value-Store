import path from 'node:path';
import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { createServer } from './http/server.ts';
import { Cluster } from './cluster/cluster.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(path.join('data', `${config.nodeId}.wal`));
  store.load();
  const cluster = new Cluster(config, store, console);
  const app = createServer(store, config, cluster);

  await cluster.listen();
  await app.listen({ port: config.httpPort, host: '0.0.0.0' });
  app.log.info(
    `node ${config.nodeId} up — http :${config.httpPort}, grpc :${config.grpcPort}, ` +
      `peers=[${config.peers.map((p) => p.id).join(', ')}]`,
  );
}

main().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
