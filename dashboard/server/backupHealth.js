import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { pathToFileURL } from 'node:url';

const API_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_JOB_PAGES = 5;
const CRONJOB = 'clickhouse-backup';
export const METRIC_NAMESPACE = 'ClaudeCodeDashboard/Backup';

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : NaN;
}

function condition(job, type) {
  return job.status?.conditions?.find(item => item.type === type && item.status === 'True');
}

// Job completion is a scheduling signal, not proof of a usable S3 snapshot.
export function evaluateBackupHealth({ cronJob, jobs, now = Date.now(), maxAgeSeconds, maxRunSeconds }) {
  const result = (reason, ageSeconds = null) => ({ healthy: reason === 'OK', reason, ageSeconds });
  if (!Number.isFinite(now) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0
      || !Number.isSafeInteger(maxRunSeconds) || maxRunSeconds <= 0) return result('INVALID_CONFIGURATION');
  if (!cronJob?.metadata?.uid || !Array.isArray(jobs)) return result('INVALID_STATUS');
  if (cronJob.spec?.suspend === true) return result('SCHEDULE_SUSPENDED');
  const successValue = cronJob.status?.lastSuccessfulTime;
  const success = successValue == null ? null : timestamp(successValue);
  if (success !== null && (!Number.isFinite(success) || success > now + 60_000)) return result('INVALID_STATUS');
  const age = success === null ? null : Math.max(0, Math.floor((now - success) / 1000));
  const owned = jobs.filter(job => Array.isArray(job?.metadata?.ownerReferences)
    && job.metadata.ownerReferences.some(ref =>
      ref?.kind === 'CronJob' && ref.uid === cronJob.metadata.uid && ref.controller === true));
  const active = cronJob.status?.active ?? [];
  if (!Array.isArray(active) || active.some(ref => !owned.some(job => job.metadata.uid === ref.uid))) {
    return result('ACTIVE_JOB_UNOBSERVED', age);
  }
  for (const job of owned) {
    if (!job.metadata.uid || (job.status?.conditions != null && !Array.isArray(job.status.conditions))) {
      return result('INVALID_STATUS', age);
    }
    const created = timestamp(job.metadata.creationTimestamp);
    if (!Number.isFinite(created) || created > now + 60_000) return result('INVALID_STATUS', age);
    const complete = condition(job, 'Complete');
    const failure = condition(job, 'Failed') ?? condition(job, 'FailureTarget');
    if (complete && failure) return result('INVALID_STATUS', age);
    if (failure) {
      const failedAt = timestamp(failure.lastTransitionTime);
      if (!Number.isFinite(failedAt) || failedAt > now + 60_000) return result('INVALID_STATUS', age);
      if (success === null || failedAt >= success) return result('JOB_FAILED', age);
    } else if (!complete) {
      const current = success === null || created >= success || job.status?.active > 0
        || active.some(ref => ref.uid === job.metadata.uid);
      if (current && job.spec?.suspend === true) return result('JOB_SUSPENDED', age);
      // Creation time includes Pending pods; startTime alone misses scheduling stalls.
      if (current && now - created >= maxRunSeconds * 1000) return result('JOB_OVERDUE', age);
    }
  }
  if (success === null) return result('NEVER_SUCCEEDED');
  if (age >= maxAgeSeconds) return result('SUCCESS_STALE', age);
  return result('OK', age);
}

export async function collectBackupStatus(getJson, namespace, signal) {
  const base = `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}`;
  const cronJob = await getJson(`${base}/cronjobs/${CRONJOB}`, signal);
  const jobs = [];
  let continuation = '';
  const seen = new Set();
  for (let page = 0; page < MAX_JOB_PAGES; page += 1) {
    const suffix = continuation ? `&continue=${encodeURIComponent(continuation)}` : '';
    const list = await getJson(`${base}/jobs?limit=100${suffix}`, signal);
    if (!Array.isArray(list?.items) || list.items.length > 100) throw new Error('INVALID_JOB_LIST');
    jobs.push(...list.items);
    continuation = list.metadata?.continue ?? '';
    if (typeof continuation !== 'string') throw new Error('INVALID_JOB_LIST');
    if (!continuation) return { cronJob, jobs };
    if (seen.has(continuation)) throw new Error('REPEATED_JOB_PAGE');
    seen.add(continuation);
  }
  throw new Error('INCOMPLETE_JOB_LIST');
}

export function kubernetesJsonReader({ hostname, port = 443, token, ca, requestImpl = request }) {
  return (path, signal) => new Promise((resolve, reject) => {
    const req = requestImpl({
      hostname, port, path, method: 'GET', ca, rejectUnauthorized: true,
      signal, timeout: API_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, response => {
      response.on('aborted', () => reject(new Error('KUBERNETES_RESPONSE_ABORTED')));
      response.on('error', () => reject(new Error('KUBERNETES_RESPONSE_FAILED')));
      if (response.statusCode !== 200) {
        reject(new Error('KUBERNETES_READ_FAILED'));
        response.destroy();
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          reject(new Error('KUBERNETES_RESPONSE_TOO_LARGE'));
          req.destroy(new Error('KUBERNETES_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('KUBERNETES_INVALID_JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('KUBERNETES_TIMEOUT')));
    req.on('error', () => reject(new Error('KUBERNETES_READ_FAILED')));
    req.end();
  });
}

export function backupMetric(health, cluster, namespace, now = new Date()) {
  return {
    Namespace: METRIC_NAMESPACE,
    MetricData: [{
      MetricName: 'Unhealthy',
      Dimensions: [
        { Name: 'ClusterName', Value: cluster },
        { Name: 'Namespace', Value: namespace },
        { Name: 'CronJob', Value: CRONJOB },
      ],
      Timestamp: now, Unit: 'Count', Value: health.healthy ? 0 : 1,
    }],
  };
}

export async function runBackupMonitor({ getJson, publish, namespace, cluster, maxAgeSeconds, maxRunSeconds, signal, now = Date.now }) {
  let health;
  try {
    const status = await collectBackupStatus(getJson, namespace, signal);
    health = evaluateBackupHealth({ ...status, now: now(), maxAgeSeconds, maxRunSeconds });
  } catch {
    health = { healthy: false, reason: 'STATUS_UNAVAILABLE', ageSeconds: null };
  }
  await publish(backupMetric(health, cluster, namespace, new Date(now())), signal);
  return health;
}

async function main() {
  const namespace = process.env.BACKUP_NAMESPACE;
  const cluster = process.env.BACKUP_CLUSTER_NAME;
  const region = process.env.AWS_REGION;
  const maxAgeSeconds = Number(process.env.BACKUP_MAX_AGE_SECONDS);
  const maxRunSeconds = Number(process.env.BACKUP_JOB_DEADLINE_SECONDS);
  const port = Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? 443);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace ?? '')
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(cluster ?? '')
      || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region ?? '')
      || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0
      || !Number.isSafeInteger(maxRunSeconds) || maxRunSeconds <= 0
      || !Number.isInteger(port) || port <= 0 || port > 65535
      || !process.env.KUBERNETES_SERVICE_HOST
      || !process.env.AWS_ROLE_ARN || !process.env.AWS_WEB_IDENTITY_TOKEN_FILE) {
    throw new Error('INVALID_CONFIGURATION');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40_000);
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let client;
  try {
    const { CloudWatchClient, PutMetricDataCommand } = await import('@aws-sdk/client-cloudwatch');
    client = new CloudWatchClient({
      region, maxAttempts: 2, requestHandler: { connectionTimeout: 3_000, requestTimeout: 5_000 },
    });
    const sa = '/var/run/secrets/kubernetes.io/serviceaccount';
    const [token, ca] = await Promise.all([readFile(`${sa}/token`, 'utf8'), readFile(`${sa}/ca.crt`)]);
    const health = await runBackupMonitor({
      getJson: kubernetesJsonReader({
        hostname: process.env.KUBERNETES_SERVICE_HOST, port, token: token.trim(), ca,
      }),
      publish: (input, signal) => client.send(new PutMetricDataCommand(input), { abortSignal: signal }),
      namespace, cluster, maxAgeSeconds, maxRunSeconds, signal: controller.signal,
    });
    console.log(JSON.stringify(health));
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    client?.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(JSON.stringify({ healthy: false, reason: 'MONITOR_FAILED' }));
    process.exitCode = 1;
  });
}
