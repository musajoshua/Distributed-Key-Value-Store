export interface Peer {
  id: string;
  host: string;
  port: number; // gRPC port
}

export interface Config {
  nodeId: string;
  httpPort: number;
  grpcPort: number;
  peers: Peer[];
  heartbeatMs: number;
  electionTimeoutMinMs: number;
  electionTimeoutMaxMs: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function intEnv(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    if (fallback === undefined) {
      throw new Error(`Missing required numeric env var: ${name}`);
    }
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Env var ${name} must be a positive integer, got: "${raw}"`);
  }
  return n;
}

function parsePeers(raw: string | undefined): Peer[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  return raw.split(',').map((entry) => {
    const trimmed = entry.trim();
    // Format: id@host:port  (e.g. node2@node2:9080). The id is that peer's NODE_ID,
    // so every node shares ONE identity namespace — needed for leader selection.
    const at = trimmed.indexOf('@');
    if (at <= 0) {
      throw new Error(`Invalid PEERS entry "${trimmed}", expected id@host:port`);
    }
    const id = trimmed.slice(0, at).trim();
    const hostPort = trimmed.slice(at + 1).trim();
    const sep = hostPort.lastIndexOf(':');
    if (sep <= 0 || sep === hostPort.length - 1) {
      throw new Error(`Invalid PEERS entry "${trimmed}", expected id@host:port`);
    }
    const host = hostPort.slice(0, sep).trim();
    const port = Number(hostPort.slice(sep + 1).trim());
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Invalid port in PEERS entry "${trimmed}"`);
    }
    return { id, host, port };
  });
}

export function loadConfig(): Config {
  const config: Config = {
    nodeId: requireEnv('NODE_ID'),
    httpPort: intEnv('HTTP_PORT'),
    grpcPort: intEnv('GRPC_PORT'),
    peers: parsePeers(process.env.PEERS),
    heartbeatMs: intEnv('HEARTBEAT_MS', 250),
    electionTimeoutMinMs: intEnv('ELECTION_TIMEOUT_MIN_MS', 1000),
    electionTimeoutMaxMs: intEnv('ELECTION_TIMEOUT_MAX_MS', 2000),
  };

  if (config.electionTimeoutMinMs >= config.electionTimeoutMaxMs) {
    throw new Error(
      `ELECTION_TIMEOUT_MIN_MS (${config.electionTimeoutMinMs}) must be < ELECTION_TIMEOUT_MAX_MS (${config.electionTimeoutMaxMs})`,
    );
  }

  return config;
}
