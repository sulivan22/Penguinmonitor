const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { Client } = require('ssh2');
const dotenv = require('dotenv');

dotenv.config();
dotenv.config({ path: path.join(process.cwd(), '.env.local'), override: true });

const app = express();
const PORT = Number(process.env.PORT || 8080);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongo:27017/dashboard_monitor';
const HISTORY_LIMIT_MAX = 50000;
const CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY || '';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const hostSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    host: { type: String, required: true, trim: true },
    port: { type: Number, required: true, default: 22 },
    username: { type: String, required: true, trim: true },
    authType: { type: String, required: true, enum: ['password', 'key'] },
    password: { type: String, default: '' },
    privateKey: { type: String, default: '' },
    passphrase: { type: String, default: '' },
    lastFetchedAt: { type: Date, default: null },
    lastStatus: { type: String, enum: ['unknown', 'online', 'error'], default: 'unknown' },
    lastError: { type: String, default: '' },
    latestSnapshot: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

const hostHistorySchema = new mongoose.Schema(
  {
    hostId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    cpuUsagePercent: { type: Number, default: null },
    memoryUsagePercent: { type: Number, default: null },
    uptimeSeconds: { type: Number, default: null },
    containersTotal: { type: Number, default: 0 },
    containersRunning: { type: Number, default: 0 },
    fetchedAt: { type: Date, required: true }
  },
  { timestamps: true }
);

hostHistorySchema.index({ hostId: 1, fetchedAt: -1 });

const Host = mongoose.model('Host', hostSchema);
const HostHistory = mongoose.model('HostHistory', hostHistorySchema);
const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

function normalizeEncryptionKey(rawKey) {
  const normalized = String(rawKey || '').trim();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized, 'utf8').digest();
}

const encryptionKey = normalizeEncryptionKey(CREDENTIALS_ENCRYPTION_KEY);

function encryptSecret(value) {
  if (!value) return '';
  if (!encryptionKey) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY is required to encrypt credentials');
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(value) {
  if (!value) return '';
  if (!String(value).startsWith('enc:v1:')) {
    return String(value);
  }
  if (!encryptionKey) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY is required to decrypt credentials');
  }

  const parts = String(value).split(':');
  if (parts.length !== 5) {
    throw new Error('Invalid encrypted secret format');
  }

  const iv = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  const encrypted = Buffer.from(parts[4], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  return decrypted.toString('utf8');
}

function asPublicHost(host) {
  return {
    id: String(host._id),
    name: host.name,
    host: host.host,
    port: host.port,
    username: host.username,
    authType: host.authType,
    lastFetchedAt: host.lastFetchedAt,
    lastStatus: host.lastStatus,
    lastError: host.lastError,
    latestSnapshot: host.latestSnapshot,
    createdAt: host.createdAt,
    updatedAt: host.updatedAt
  };
}

function validateAuthPayload(auth) {
  if (!auth || typeof auth !== 'object') return 'auth payload is required';
  const { name, host, port, username, authType, password, privateKey } = auth;

  if (!name || typeof name !== 'string') return 'name is required';
  if (!host || typeof host !== 'string') return 'host is required';
  if (!username || typeof username !== 'string') return 'username is required';

  const parsedPort = Number(port ?? 22);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return 'port is invalid';
  }

  if (authType !== 'password' && authType !== 'key') {
    return 'authType must be password or key';
  }

  if (authType === 'password' && (!password || typeof password !== 'string')) {
    return 'password is required when authType=password';
  }

  if (authType === 'key' && (!privateKey || typeof privateKey !== 'string')) {
    return 'privateKey is required when authType=key';
  }

  return null;
}

function createConnection(auth) {
  const conn = new Client();
  const config = {
    host: auth.host,
    port: Number(auth.port ?? 22),
    username: auth.username,
    readyTimeout: 12000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3
  };

  if (auth.authType === 'password') {
    config.password = auth.password;
  } else {
    config.privateKey = auth.privateKey;
    if (auth.passphrase) config.passphrase = auth.passphrase;
  }

  return { conn, config };
}

function toHostAuth(hostDoc) {
  return {
    host: hostDoc.host,
    port: hostDoc.port,
    username: hostDoc.username,
    authType: hostDoc.authType,
    password: decryptSecret(hostDoc.password),
    privateKey: decryptSecret(hostDoc.privateKey),
    passphrase: decryptSecret(hostDoc.passphrase)
  };
}

function execCommand(conn, command, options = {}) {
  const combineStderr = Boolean(options.combineStderr);

  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);

      let stdout = '';
      let stderr = '';

      stream.on('close', (code) => {
        const combined = combineStderr ? `${stdout}${stderr}` : stdout;

        if (code !== 0) {
          const errMsg = (combineStderr ? combined : stderr).trim() || `Command failed with code ${code}`;
          return reject(new Error(errMsg));
        }
        resolve(combined.trim());
      });

      stream.on('data', (data) => {
        stdout += data.toString();
      });

      stream.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    });
  });
}

function parseMemory(memRaw) {
  const lines = memRaw.split('\n').map((line) => line.trim()).filter(Boolean);
  const memoryLine = lines.find((line) => line.toLowerCase().startsWith('mem:'));
  if (!memoryLine) return null;

  const cols = memoryLine.split(/\s+/);
  if (cols.length < 4) return null;

  const total = Number(cols[1]);
  const used = Number(cols[2]);
  const free = Number(cols[3]);
  const usage = total > 0 ? Number(((used / total) * 100).toFixed(1)) : 0;

  return { totalMB: total, usedMB: used, freeMB: free, usagePercent: usage };
}

function parseCpu(cpuRaw) {
  const normalized = String(cpuRaw ?? '').trim().replace(',', '.');
  const usage = Number.parseFloat(normalized);
  if (Number.isNaN(usage)) {
    return { usagePercent: null };
  }

  return { usagePercent: Math.max(0, Math.min(100, Number(usage.toFixed(1)))) };
}

function parseUptime(uptimeRaw) {
  const [uptimeSecRaw] = String(uptimeRaw).split(/\s+/);
  const uptimeSec = Number.parseFloat(uptimeSecRaw);
  if (Number.isNaN(uptimeSec)) {
    return { seconds: null, human: 'Unknown' };
  }

  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);

  return {
    seconds: Math.floor(uptimeSec),
    human: parts.join(' ')
  };
}

function parseDockerList(raw) {
  const lines = String(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .map((line) => {
      try {
        const obj = JSON.parse(line);
        const state = (obj.State || '').toLowerCase();
        return {
          id: obj.ID,
          name: obj.Names,
          image: obj.Image,
          state,
          status: obj.Status,
          isRunning: state === 'running'
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function withSsh(auth, work) {
  return new Promise((resolve, reject) => {
    const { conn, config } = createConnection(auth);

    conn.on('ready', async () => {
      try {
        const result = await work(conn);
        conn.end();
        resolve(result);
      } catch (error) {
        conn.end();
        reject(error);
      }
    });

    conn.on('error', (error) => {
      reject(error);
    });

    conn.connect(config);
  });
}

async function collectSnapshot(hostDoc) {
  return withSsh(hostDoc, async (conn) => {
    const [memRaw, cpuRaw, uptimeRaw, dockerRaw] = await Promise.all([
      execCommand(conn, 'free -m'),
      execCommand(
        conn,
        "sh -c 'read _ u n s i w q z t _ < /proc/stat; total1=$((u+n+s+i+w+q+z+t)); idle1=$((i+w)); sleep 1; read _ u n s i w q z t _ < /proc/stat; total2=$((u+n+s+i+w+q+z+t)); idle2=$((i+w)); dt=$((total2-total1)); di=$((idle2-idle1)); if [ $dt -gt 0 ]; then awk \"BEGIN { printf \\\"%.1f\\\", (1-($di/$dt))*100 }\"; else echo 0.0; fi'"
      ).catch(() => ''),
      execCommand(conn, 'cat /proc/uptime'),
      execCommand(conn, "docker ps -a --format '{{json .}}'").catch(() => '')
    ]);

    const containers = parseDockerList(dockerRaw);
    const runningContainers = containers.filter((item) => item.isRunning).length;

    return {
      memory: parseMemory(memRaw),
      cpu: parseCpu(cpuRaw),
      uptime: parseUptime(uptimeRaw),
      containers,
      containersSummary: {
        total: containers.length,
        running: runningContainers,
        stopped: containers.length - runningContainers
      },
      fetchedAt: new Date().toISOString()
    };
  });
}

async function persistSnapshot(hostDoc, snapshot) {
  const fetchedAtDate = new Date(snapshot.fetchedAt);

  hostDoc.lastFetchedAt = fetchedAtDate;
  hostDoc.lastStatus = 'online';
  hostDoc.lastError = '';
  hostDoc.latestSnapshot = snapshot;
  await hostDoc.save();

  await HostHistory.create({
    hostId: hostDoc._id,
    cpuUsagePercent: snapshot.cpu?.usagePercent ?? null,
    memoryUsagePercent: snapshot.memory?.usagePercent ?? null,
    uptimeSeconds: snapshot.uptime?.seconds ?? null,
    containersTotal: snapshot.containersSummary?.total ?? 0,
    containersRunning: snapshot.containersSummary?.running ?? 0,
    fetchedAt: fetchedAtDate
  });
}

app.get(
  '/api/health',
  asyncHandler(async (_req, res) => {
    const mongoState = mongoose.connection.readyState === 1 ? 'up' : 'down';
    res.json({ ok: true, mongo: mongoState, now: new Date().toISOString() });
  })
);

app.get(
  '/api/hosts',
  asyncHandler(async (_req, res) => {
    const hosts = await Host.find({}).sort({ createdAt: 1 });
    res.json({ items: hosts.map(asPublicHost) });
  })
);

app.post(
  '/api/hosts',
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const error = validateAuthPayload(payload);
    if (error) {
      return res.status(400).json({ error });
    }

    const host = await Host.create({
      name: payload.name.trim(),
      host: payload.host.trim(),
      port: Number(payload.port ?? 22),
      username: payload.username.trim(),
      authType: payload.authType,
      password: payload.authType === 'password' ? encryptSecret(payload.password) : '',
      privateKey: payload.authType === 'key' ? encryptSecret(payload.privateKey) : '',
      passphrase: payload.authType === 'key' ? encryptSecret(payload.passphrase || '') : ''
    });

    return res.status(201).json({ item: asPublicHost(host) });
  })
);

app.delete(
  '/api/hosts/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const host = await Host.findByIdAndDelete(id);
    if (!host) {
      return res.status(404).json({ error: 'Host not found' });
    }

    await HostHistory.deleteMany({ hostId: host._id });
    return res.json({ ok: true });
  })
);

app.get(
  '/api/home/summary',
  asyncHandler(async (_req, res) => {
    const hosts = await Host.find({}).sort({ createdAt: 1 });
    const totalHosts = hosts.length;
    const onlineHosts = hosts.filter((host) => host.lastStatus === 'online').length;

    const cpuValues = hosts
      .map((host) => host.latestSnapshot?.cpu?.usagePercent)
      .filter((value) => typeof value === 'number');
    const ramValues = hosts
      .map((host) => host.latestSnapshot?.memory?.usagePercent)
      .filter((value) => typeof value === 'number');

    const cpuAvg = cpuValues.length
      ? Number((cpuValues.reduce((acc, value) => acc + value, 0) / cpuValues.length).toFixed(1))
      : null;
    const ramAvg = ramValues.length
      ? Number((ramValues.reduce((acc, value) => acc + value, 0) / ramValues.length).toFixed(1))
      : null;

    const rows = hosts.map((host) => ({
      id: String(host._id),
      name: host.name,
      host: host.host,
      status: host.lastStatus,
      cpuUsagePercent: host.latestSnapshot?.cpu?.usagePercent ?? null,
      memoryUsagePercent: host.latestSnapshot?.memory?.usagePercent ?? null,
      uptimeHuman: host.latestSnapshot?.uptime?.human ?? '--',
      containersSummary: host.latestSnapshot?.containersSummary || { total: 0, running: 0, stopped: 0 },
      lastFetchedAt: host.lastFetchedAt
    }));

    return res.json({
      totals: {
        totalHosts,
        onlineHosts,
        cpuAvg,
        ramAvg
      },
      rows
    });
  })
);

app.get(
  '/api/hosts/:id/detail',
  asyncHandler(async (req, res) => {
    const host = await Host.findById(req.params.id);
    if (!host) {
      return res.status(404).json({ error: 'Host not found' });
    }

    return res.json({ item: asPublicHost(host) });
  })
);

app.get(
  '/api/hosts/:id/history',
  asyncHandler(async (req, res) => {
    const host = await Host.findById(req.params.id).select('_id');
    if (!host) {
      return res.status(404).json({ error: 'Host not found' });
    }

    const rangeMap = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '24hr': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '14d': 14 * 24 * 60 * 60 * 1000
    };
  const range = String(req.query.range || '').trim();
  const minDate = rangeMap[range] ? new Date(Date.now() - rangeMap[range]) : null;

  const requestedLimit = Number(req.query.limit ?? HISTORY_LIMIT_MAX);
  const limit = Number.isInteger(requestedLimit)
    ? Math.max(1, Math.min(HISTORY_LIMIT_MAX, requestedLimit))
    : HISTORY_LIMIT_MAX;

  const query = { hostId: host._id };
  if (minDate) {
    query.fetchedAt = { $gte: minDate };
  }

  const points = await HostHistory.find(query)
    .sort({ fetchedAt: -1 })
    .limit(limit)
    .lean();

    return res.json({
    items: points
      .reverse()
      .map((point) => ({
          fetchedAt: point.fetchedAt,
          cpuUsagePercent: point.cpuUsagePercent,
          memoryUsagePercent: point.memoryUsagePercent,
          uptimeSeconds: point.uptimeSeconds,
          containersTotal: point.containersTotal,
          containersRunning: point.containersRunning
      }))
  });
  })
);

app.post(
  '/api/hosts/:id/containers/logs',
  asyncHandler(async (req, res) => {
  const host = await Host.findById(req.params.id);
  if (!host) {
    return res.status(404).json({ error: 'Host not found' });
  }

  const { containerName } = req.body || {};
  if (!containerName || typeof containerName !== 'string') {
    return res.status(400).json({ error: 'containerName is required' });
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(containerName)) {
    return res.status(400).json({ error: 'containerName has invalid characters' });
  }

  try {
    const logsRaw = await withSsh(
      toHostAuth(host),
      (conn) => execCommand(conn, `docker logs ${containerName}`, { combineStderr: true })
    );
    const maxChars = 250000;
    const logs = logsRaw.length > maxChars ? logsRaw.slice(logsRaw.length - maxChars) : logsRaw;
    return res.json({ ok: true, containerName, logs });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to get container logs',
      details: error.message
    });
  }
  })
);

app.post(
  '/api/hosts/:id/fetch',
  asyncHandler(async (req, res) => {
    const host = await Host.findById(req.params.id);
    if (!host) {
      return res.status(404).json({ error: 'Host not found' });
    }

    try {
      const snapshot = await collectSnapshot(toHostAuth(host));
      await persistSnapshot(host, snapshot);
      return res.json({ item: asPublicHost(host), snapshot });
    } catch (error) {
      host.lastStatus = 'error';
      host.lastError = error.message;
      await host.save();

      return res.status(500).json({
        error: 'Failed to fetch metrics from host',
        details: error.message
      });
    }
  })
);

app.post(
  '/api/hosts/:id/containers/action',
  asyncHandler(async (req, res) => {
    const host = await Host.findById(req.params.id);
    if (!host) {
      return res.status(404).json({ error: 'Host not found' });
    }

    const { containerName, action } = req.body || {};
    if (!containerName || typeof containerName !== 'string') {
      return res.status(400).json({ error: 'containerName is required' });
    }

    if (!/^[a-zA-Z0-9_.-]+$/.test(containerName)) {
      return res.status(400).json({ error: 'containerName has invalid characters' });
    }

    if (action !== 'start' && action !== 'stop') {
      return res.status(400).json({ error: 'action must be start or stop' });
    }

    try {
      await withSsh(toHostAuth(host), (conn) => execCommand(conn, `docker ${action} ${containerName}`));

      const snapshot = await collectSnapshot(toHostAuth(host));
      await persistSnapshot(host, snapshot);

      return res.json({ ok: true, snapshot });
    } catch (error) {
      host.lastStatus = 'error';
      host.lastError = error.message;
      await host.save();

      return res.status(500).json({
        error: `Failed to ${action} container`,
        details: error.message
      });
    }
  })
);

app.use((error, _req, res, _next) => {
  return res.status(500).json({ error: 'Internal server error', details: error.message });
});

async function start() {
  if (!encryptionKey) {
    throw new Error('Missing CREDENTIALS_ENCRYPTION_KEY. Define it in .env or .env.local');
  }

  await mongoose.connect(MONGODB_URI);

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Dashboard server listening on http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', error.message);
  process.exit(1);
});
