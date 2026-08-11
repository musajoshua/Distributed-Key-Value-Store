import Fastify, { type FastifyInstance } from 'fastify';
import type { Store } from '../store.ts';
import type { Config } from '../config.ts';
import type { Cluster } from '../cluster/cluster.ts';

interface IParams {
  key: string
}

interface IBody {
  value: string
}

export function createServer(store: Store, config: Config, cluster: Cluster): FastifyInstance {
  const app = Fastify({ logger: true });

  app.put<{ Params: IParams; Body: IBody }>(
    '/store/:key',
    async (req, reply) => {
      const { key } = req.params;
      const value =  req.body?.value;
      if (typeof value !== 'string') {
        return reply.code(400).send({ error: 'body must be { "value": <string> }' });
      }

      const lsn = store.put(key, value);
      return reply.code(200).send({ ok: true, lsn });
    },
  );

  app.get<{ Params: IParams }>('/store/:key', async (req, reply) => {
    const value = store.get(req.params.key);
    if (value === null) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.code(200).send({ value });
  });

  app.delete<{ Params: IParams }>('/store/:key', async (req, reply) => {
    const { existed } = store.delete(req.params.key);
    if (!existed) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.code(200).send({ ok: true });
  });

  app.get('/health', async (_req, reply) => {
    return reply.code(200).send({
      status: 'healthy',
      nodeId: config.nodeId,
      nodes: config.peers.length + 1,
      role: cluster.isLeader ? 'leader' : 'follower',
    });
  });

  return app;
}
