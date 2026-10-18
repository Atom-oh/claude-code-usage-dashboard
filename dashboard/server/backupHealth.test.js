import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  evaluateBackupHealth, collectBackupStatus, runBackupMonitor, backupMetric, kubernetesJsonReader,
} from './backupHealth.js';

const now = Date.parse('2026-10-18T12:00:00Z');
const time = hoursAgo => new Date(now - hoursAgo * 3_600_000).toISOString();
const options = { now, maxAgeSeconds: 27 * 3600, maxRunSeconds: 7200 };
function cron(overrides = {}) {
  return { metadata: { uid: 'cron-uid' }, spec: {}, status: { lastSuccessfulTime: time(18) }, ...overrides };
}
function job(hoursAgo, status = {}, extra = {}) {
  return {
    metadata: { uid: `job-${hoursAgo}`, creationTimestamp: time(hoursAgo),
      ownerReferences: [{ kind: 'CronJob', uid: 'cron-uid', controller: true }] },
    status, ...extra,
  };
}
const evaluate = (cronJob = cron(), jobs = []) => evaluateBackupHealth({ ...options, cronJob, jobs });
const failed = hoursAgo => ({ conditions: [{ type: 'Failed', status: 'True', lastTransitionTime: time(hoursAgo) }] });

for (const [name, cronJob, jobs, reason] of [
  ['fresh success with no retained Jobs', cron(), [], 'OK'],
  ['never completed', cron({ status: {} }), [], 'NEVER_SUCCEEDED'],
  ['stale success', cron({ status: { lastSuccessfulTime: time(28) } }), [], 'SUCCESS_STALE'],
  ['exact age boundary', cron({ status: { lastSuccessfulTime: time(27) } }), [], 'SUCCESS_STALE'],
  ['suspended schedule', cron({ spec: { suspend: true } }), [], 'SCHEDULE_SUSPENDED'],
  ['new terminal failure', cron(), [job(1, failed(0.9))], 'JOB_FAILED'],
  ['retry count is not terminal failure', cron(), [job(0.5, { failed: 1 })], 'OK'],
  ['old failure followed by success', cron(), [job(20, failed(19))], 'OK'],
  ['failure after newer success', cron(), [job(20, failed(1))], 'JOB_FAILED'],
  ['overdue Pending job', cron(), [job(3)], 'JOB_OVERDUE'],
  ['exact run boundary', cron(), [job(2)], 'JOB_OVERDUE'],
  ['recent Pending job', cron(), [job(1)], 'OK'],
  ['older active job still overdue', cron(), [job(20, { active: 1 })], 'JOB_OVERDUE'],
  ['new suspended job', cron(), [job(1, {}, { spec: { suspend: true } })], 'JOB_SUSPENDED'],
  ['historical suspended manual job', cron(), [job(20, {}, { spec: { suspend: true } })], 'OK'],
  ['unobserved active reference', cron({ status: { lastSuccessfulTime: time(18), active: [{ uid: 'missing' }] } }), [], 'ACTIVE_JOB_UNOBSERVED'],
  ['future success', cron({ status: { lastSuccessfulTime: time(-1) } }), [], 'INVALID_STATUS'],
  ['malformed success', cron({ status: { lastSuccessfulTime: 'not-a-date' } }), [], 'INVALID_STATUS'],
  ['invalid calendar date', cron({ status: { lastSuccessfulTime: '2026-02-31T10:00:00Z' } }), [], 'INVALID_STATUS'],
  ['foreign owner ignored', cron(), [job(3, failed(1), { metadata: { uid: 'foreign', creationTimestamp: time(3), ownerReferences: [{ kind: 'CronJob', uid: 'other', controller: true }] } })], 'OK'],
  ['non-controller owner ignored', cron(), [job(3, failed(1), { metadata: { uid: 'foreign', creationTimestamp: time(3), ownerReferences: [{ kind: 'CronJob', uid: 'cron-uid', controller: false }] } })], 'OK'],
  ['missing Job identity', cron(), [job(3, {}, { metadata: { creationTimestamp: time(3), ownerReferences: [{ kind: 'CronJob', uid: 'cron-uid', controller: true }] } })], 'INVALID_STATUS'],
  ['invalid conditions', cron(), [job(1, { conditions: {} })], 'INVALID_STATUS'],
  ['missing failure timestamp', cron(), [job(1, { conditions: [{ type: 'Failed', status: 'True' }] })], 'INVALID_STATUS'],
  ['completed historical job', cron(), [job(20, { conditions: [{ type: 'Complete', status: 'True' }] })], 'OK'],
  ['completion criteria alone is overdue', cron(), [job(3, { conditions: [{ type: 'SuccessCriteriaMet', status: 'True' }] })], 'JOB_OVERDUE'],
  ['failure criteria alert before termination', cron(), [job(1, { conditions: [{ type: 'FailureTarget', status: 'True', lastTransitionTime: time(0.5) }] })], 'JOB_FAILED'],
  ['contradictory terminal conditions', cron(), [job(1, { conditions: [{ type: 'Complete', status: 'True' }, ...failed(0.5).conditions] })], 'INVALID_STATUS'],
]) {
  test(name, () => {
    const health = evaluate(cronJob, jobs);
    assert.equal(health.reason, reason);
    assert.equal(health.healthy, reason === 'OK');
  });
}

test('invalid limits never report healthy', () => {
  assert.equal(evaluateBackupHealth({ ...options, cronJob: cron(), jobs: [], maxAgeSeconds: NaN }).reason, 'INVALID_CONFIGURATION');
});

test('pagination preserves encoded continuation and complete inventory', async () => {
  const paths = [];
  const replies = [cron(), { items: [job(1)], metadata: { continue: 'a&b/=' } }, { items: [job(20)], metadata: {} }];
  const result = await collectBackupStatus(async path => { paths.push(path); return replies.shift(); }, 'test-namespace');
  assert.equal(result.jobs.length, 2);
  assert.equal(paths[2], '/apis/batch/v1/namespaces/test-namespace/jobs?limit=100&continue=a%26b%2F%3D');
});

test('incomplete and repeated pagination cannot report healthy', async () => {
  for (const repeated of [true, false]) {
    let count = 0;
    await assert.rejects(collectBackupStatus(async () => {
      count += 1;
      return count === 1 ? cron() : { items: [], metadata: { continue: repeated ? 'same' : `page-${count}` } };
    }, 'test'), /REPEATED_JOB_PAGE|INCOMPLETE_JOB_LIST/);
    assert.ok(count <= 6);
  }
});

test('oversized and invalid job pages fail closed', async () => {
  for (const list of [{ items: Array(101).fill(job(1)) }, { items: {} }, { items: [], metadata: { continue: 12 } }]) {
    let count = 0;
    await assert.rejects(collectBackupStatus(async () => ++count === 1 ? cron() : list, 'test'));
  }
});

test('read failure publishes unhealthy, without exception text or credentials', async () => {
  let input;
  const result = await runBackupMonitor({
    getJson: async () => { throw new Error('fixture-password-must-not-appear'); },
    publish: async value => { input = value; }, namespace: 'test', cluster: 'fixture',
    ...options, now: () => now,
  });
  assert.equal(result.reason, 'STATUS_UNAVAILABLE');
  assert.equal(input.MetricData[0].Value, 1);
  assert.ok(!JSON.stringify({ input, result }).includes('fixture-password'));
});

test('fresh healthy status publishes zero to one fixed metric and stable dimensions', async () => {
  let count = 0;
  let input;
  const result = await runBackupMonitor({
    getJson: async () => ++count === 1 ? cron() : { items: [] },
    publish: async value => { input = value; }, namespace: 'test', cluster: 'fixture',
    ...options, now: () => now,
  });
  assert.equal(result.healthy, true);
  assert.deepEqual(input, backupMetric(result, 'fixture', 'test', new Date(now)));
  assert.equal(input.Namespace, 'ClaudeCodeDashboard/Backup');
  assert.equal(input.MetricData.length, 1);
  assert.equal(input.MetricData[0].Value, 0);
  assert.deepEqual(input.MetricData[0].Dimensions.map(item => item.Name), ['ClusterName', 'Namespace', 'CronJob']);
});

test('metric publication errors propagate and do not manufacture a success', async () => {
  let count = 0;
  await assert.rejects(runBackupMonitor({
    getJson: async () => ++count === 1 ? cron() : { items: [] },
    publish: async () => { throw new Error('publication failed'); }, namespace: 'test', cluster: 'fixture',
    ...options, now: () => now,
  }), /publication failed/);
});

function mockRequest(responseBody, statusCode = 200, afterDestroy = () => {}) {
  const captured = {};
  const implementation = (options, callback) => {
    captured.options = options;
    const req = new EventEmitter();
    req.destroy = error => queueMicrotask(() => req.emit('error', error));
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.resume = () => { captured.drained = true; };
      response.destroy = () => {
        captured.destroyed = true;
        queueMicrotask(() => afterDestroy(response));
      };
      callback(response);
      if (statusCode === 200) {
        response.emit('data', responseBody);
        response.emit('end');
      }
    });
    captured.req = req;
    return req;
  };
  return { captured, implementation };
}

test('Kubernetes reader verifies mounted CA, passes cancellation and limits each response', async () => {
  const mock = mockRequest(Buffer.from('{"items":[]}'));
  const signal = new AbortController().signal;
  const get = kubernetesJsonReader({ hostname: 'fixture', token: 'fixture-token', ca: 'fixture-ca', requestImpl: mock.implementation });
  assert.deepEqual(await get('/fixture', signal), { items: [] });
  assert.equal(mock.captured.options.rejectUnauthorized, true);
  assert.equal(mock.captured.options.ca, 'fixture-ca');
  assert.equal(mock.captured.options.signal, signal);
  assert.equal(mock.captured.options.timeout, 5000);
  const large = mockRequest(Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(kubernetesJsonReader({ requestImpl: large.implementation })('/fixture'), /KUBERNETES_RESPONSE_TOO_LARGE/);
});

test('Kubernetes permission and malformed JSON errors do not expose response content', async () => {
  for (const [body, code] of [[Buffer.from('sensitive-body'), 403], [Buffer.from('sensitive-body'), 200]]) {
    const mock = mockRequest(body, code);
    await assert.rejects(kubernetesJsonReader({ requestImpl: mock.implementation })('/fixture'), error => !error.message.includes('sensitive-body'));
    if (code !== 200) {
      assert.equal(mock.captured.destroyed, true);
      assert.equal(mock.captured.drained, undefined);
    }
  }
});

for (const event of ['error', 'aborted']) {
  test(`Kubernetes non-200 ${event} after cleanup publishes unhealthy without crashing`, async () => {
    const mock = mockRequest(Buffer.from('sensitive-body'), 403, response => {
      response.emit(event, new Error('sensitive-response-error'));
    });
    let input;
    const health = await runBackupMonitor({
      getJson: kubernetesJsonReader({ requestImpl: mock.implementation }),
      publish: async value => { input = value; },
      namespace: 'test', cluster: 'fixture', ...options, now: () => now,
    });
    assert.equal(mock.captured.destroyed, true);
    assert.equal(mock.captured.drained, undefined);
    assert.equal(health.reason, 'STATUS_UNAVAILABLE');
    assert.equal(input.MetricData[0].Value, 1);
    assert.ok(!JSON.stringify({ health, input }).includes('sensitive'));
  });
}

test('Terraform binds worker budgets, role scope, dimensions and missing data', () => {
  const tf = readFileSync(new URL('../../infra/backup-monitor.tf', import.meta.url), 'utf8');
  const backup = readFileSync(new URL('../../infra/clickhouse.tf', import.meta.url), 'utf8');
  assert.match(tf, /"cloudwatch:namespace"\s*=\s*"ClaudeCodeDashboard\/Backup"/);
  assert.match(tf, /Action\s*=\s*\["cloudwatch:PutMetricData"\]/);
  assert.match(tf, /:sub"\s*=\s*"system:serviceaccount:\$\{var.k8s_namespace\}:clickhouse-backup-monitor"/);
  assert.match(tf, /resource_names\s*=\s*\[kubernetes_cron_job_v1.backup.metadata\[0\].name\]/);
  assert.doesNotMatch(tf, /resources\s*=\s*\[[^\]]*(?:secrets|pods|exec)/);
  assert.match(tf, /treat_missing_data\s*=\s*"breaching"/);
  assert.match(tf, /datapoints_to_alarm\s*=\s*2/);
  assert.match(tf, /evaluation_periods\s*=\s*3/);
  assert.match(tf, /command\s*=\s*\["node", "server\/backupHealth.js"\]/);
  assert.match(tf, /limits\s*=\s*\{ cpu = "100m", memory = "256Mi" \}/);
  assert.match(tf, /read_only_root_filesystem\s*=\s*true/);
  assert.match(tf, /active_deadline_seconds\s*=\s*120/);
  assert.match(tf, /backoff_limit\s*=\s*0/);
  assert.match(tf, /ignore_changes\s*=\s*\[spec\[0\]\.job_template\[0\]\.spec\[0\]\.template\[0\]\.spec\[0\]\.container\[0\]\.image\]/);
  assert.match(backup, /active_deadline_seconds\s*=\s*var.backup_job_deadline_seconds/);
});

test('installed CloudWatch SDK serializes the fixed metric with a synthetic transport', async () => {
  const { CloudWatchClient, PutMetricDataCommand } = await import('@aws-sdk/client-cloudwatch');
  let observed;
  const client = new CloudWatchClient({
    region: 'ap-northeast-2', maxAttempts: 1,
    credentials: { accessKeyId: 'synthetic-access-key', secretAccessKey: 'synthetic-secret-key' },
    requestHandler: {
      handle: async (httpRequest, handlerOptions) => {
        observed = { httpRequest, handlerOptions };
        return { response: {
          statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-requestid': 'synthetic' },
          body: Readable.from(['{}']),
        } };
      },
    },
  });
  try {
    const signal = new AbortController().signal;
    await client.send(new PutMetricDataCommand(backupMetric({ healthy: true }, 'fixture', 'test')), { abortSignal: signal });
    assert.equal(observed.httpRequest.hostname, 'monitoring.ap-northeast-2.amazonaws.com');
    assert.equal(observed.httpRequest.method, 'POST');
    assert.match(observed.httpRequest.headers['x-amz-target'], /\.PutMetricData$/);
    const body = JSON.parse(observed.httpRequest.body);
    assert.equal(body.Namespace, 'ClaudeCodeDashboard/Backup');
    assert.equal(body.MetricData[0].MetricName, 'Unhealthy');
    assert.equal(body.MetricData[0].Value, 0);
    assert.deepEqual(body.MetricData[0].Dimensions, backupMetric({ healthy: true }, 'fixture', 'test').MetricData[0].Dimensions);
    assert.equal(observed.handlerOptions.abortSignal, signal);
  } finally {
    client.destroy();
  }
});

test('worker CLI rejects missing configuration before AWS or Kubernetes setup', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./backupHealth.js', import.meta.url))], {
    env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { healthy: false, reason: 'MONITOR_FAILED' });
});
