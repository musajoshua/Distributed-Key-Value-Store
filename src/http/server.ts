import Fastify, { type FastifyInstance } from 'fastify';
import type { Store } from '../store.ts';
import type { Config } from '../config.ts';
import type { Cluster, WriteStatus } from '../cluster/cluster.ts';

interface IParams {
  key: string
}

interface IBody {
  value: string
}

const mapStatusToCode = (status: WriteStatus): number => {
  if(status === 'NOT_FOUND') return 404
  if(status === 'NO_MAJORITY_ACK') return 504
  if(status === 'NO_LEADER') return 503
  return 200
}

const errorFor = (status: WriteStatus): string => {
  if(status === 'NOT_FOUND') return 'not found'
  if(status === 'NO_MAJORITY_ACK') return 'could not reach a majority'
  if(status === 'NO_LEADER') return 'no leader available; retry'
  return 'error'
}

// One place both PUT and DELETE shape their response: lsn on success, a
// consistent { error } on any failure — so the two handlers can't drift.
const writeResponse = (result: { status: WriteStatus; lsn?: number }): { code: number; body: Record<string, unknown> } => {
  const code = mapStatusToCode(result.status)
  return result.status === 'OK'
    ? { code, body: { lsn: result.lsn } }
    : { code, body: { error: errorFor(result.status) } }
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

      const op = {key, value, deleted: false}

      const result = cluster.isLeader ? await cluster.write(op) : await cluster.forwardToLeader(op);

      const { code, body } = writeResponse(result)
      return reply.code(code).send(body)
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
    const { key } = req.params;

    const op = {key, value: '', deleted: true}

    const result = cluster.isLeader ? await cluster.write(op) : await cluster.forwardToLeader(op);

    const { code, body } = writeResponse(result)
    return reply.code(code).send(body)
  });

  app.get('/health', async (_req, reply) => {
    return reply.code(200).send({
      status: 'healthy',
      nodeId: config.nodeId,
      nodes: config.peers.length + 1,
      role: cluster.roleName,
    });
  });

  return app;
}
