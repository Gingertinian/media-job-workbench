import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { binary } from '../server/runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const dataDir = path.join(root, 'evidence', 'test-data', runId);
const measured = [], exec = promisify(execFile), began = performance.now();
const ffmpeg = binary('ffmpeg'), ffprobe = binary('ffprobe');
let server, base;
const children = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, fn) {
  const start = performance.now();
  try { const details = await fn(); measured.push({ name, pass: true, elapsedMs: Math.round(performance.now() - start), ...(details || {}) }); }
  catch (e) { measured.push({ name, pass: false, error: e.message }); throw e; }
}
async function launch() {
  server = spawn(process.execPath, ['server/main.mjs'], { cwd: root,
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(server); server.once('exit', () => children.delete(server));
  let output = '', errors = '';
  server.stderr.on('data', chunk => errors = (errors + chunk).slice(-2000));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server readiness timed out: ' + errors)), 10000);
    server.stdout.on('data', chunk => {
      output += chunk;
      const line = output.split('\n').find(line => line.includes('"ready":true'));
      if (line) { base = JSON.parse(line).url; clearTimeout(timer); resolve(); }
    });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${errors}`)); });
  });
}
async function stop(signal = 'SIGTERM') {
  if (!server || server.exitCode !== null) return;
  const finished = once(server, 'exit'); server.kill(signal); await finished;
}
async function request(url, options) {
  const response = await fetch(base + url, options);
  const body = await response.json(); return { response, body };
}
async function upload(bytes, name = 'pendulum.mp4') {
  return request('/api/assets', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': name }, body: bytes });
}
async function enqueue(assetId, start, duration, key = randomUUID()) {
  return request('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ assetId, start, duration }) });
}
async function waitFor(id, statuses, timeout = 20000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const { body } = await request('/api/jobs/' + id);
    if (statuses.includes(body.status)) return body;
    await sleep(10);
  }
  throw new Error('Job state timed out: ' + statuses.join(', '));
}
async function probe(file) {
  const { stdout } = await exec(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true });
  return JSON.parse(stdout);
}
let failure;
try {
  await mkdir(dataDir, { recursive: true });
  const sample = path.join(root, 'samples', 'pendulum.mp4');
  await check('authored sample generation', async () => {
    await exec(process.execPath, ['scripts/sample.mjs'], { cwd: root, windowsHide: true, timeout: 30000 });
    const meta = await probe(sample);
    assert.equal(Number(meta.format.duration), 8);
    assert(meta.streams.some(s => s.codec_type === 'audio'));
    return { durationSeconds: Number(meta.format.duration), bytes: Number(meta.format.size) };
  });
  await launch();
  let asset, job;
  await check('file upload and metadata', async () => {
    const { response, body } = await upload(await readFile(sample));
    assert.equal(response.status, 201); assert.equal(body.width, 640); assert.equal(body.duration, 8); asset = body;
    return { width: body.width, height: body.height, durationSeconds: body.duration };
  });
  await check('invalid media and invalid trim rejected', async () => {
    assert.equal((await upload(Buffer.from('not video'))).response.status, 422);
    assert.equal((await enqueue(asset.id, 7, 2)).response.status, 400);
    assert.equal((await enqueue(asset.id, -1, 2)).response.status, 400);
    assert.equal((await enqueue(asset.id, 0, 31)).response.status, 400);
    assert.equal((await enqueue(randomUUID(), 0, 2)).response.status, 404);
    assert.equal((await request('/api/jobs', { method: 'POST', body: '{}' })).response.status, 400);
    return { rejectedCases: 6 };
  });
  const key = randomUUID();
  await check('concurrent idempotency and conflict detection', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => enqueue(asset.id, 1, 2, key)));
    const ids = new Set(responses.map(r => r.body.id)); assert.equal(ids.size, 1);
    assert.equal(responses.filter(r => r.response.status === 202).length, 1);
    assert.equal(responses.filter(r => r.response.headers.get('Idempotency-Replayed') === 'true').length, 7);
    assert.equal((await enqueue(asset.id, 2, 2, key)).response.status, 409);
    job = responses[0].body;
    return { concurrentRequests: 8, distinctJobs: ids.size, replayed: 7 };
  });
  await check('real trim export with audio and decode', async () => {
    job = await waitFor(job.id, ['completed', 'error']); assert.equal(job.status, 'completed', job.error);
    assert.deepEqual(job.events.map(e => e.status), ['queued', 'working', 'completed']);
    const file = path.join(dataDir, 'outputs', job.id + '.mp4'), meta = await probe(file);
    assert(Math.abs(Number(meta.format.duration) - 2) < 0.1);
    assert.equal(meta.streams.find(s => s.codec_type === 'video').codec_name, 'h264');
    assert.equal(meta.streams.find(s => s.codec_type === 'audio').codec_name, 'aac');
    await exec(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], { windowsHide: true, timeout: 15000 });
    // Compare decoded luma at a known frame to detect exporting the wrong time window.
    const frame = async (file, time) => (await exec(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { windowsHide: true, encoding: 'buffer', maxBuffer: 1024 * 1024 })).stdout;
    const expected = await frame(sample, 1), actual = await frame(file, 0), wrong = await frame(sample, 0);
    const distance = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
    const aligned = distance(expected, actual), unaligned = distance(wrong, actual);
    assert.equal(actual.length, expected.length); assert(aligned < unaligned / 2);
    return { durationSeconds: Number(meta.format.duration), bytes: Number(meta.format.size), codecs: ['h264', 'aac'], frameMeanAbsoluteError: Number(aligned.toFixed(4)), wrongStartError: Number(unaligned.toFixed(4)), states: job.events.map(e => e.status) };
  });
  await check('playback byte ranges and download', async () => {
    const response = await fetch(base + job.resultUrl, { headers: { Range: 'bytes=0-127' } });
    assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 128);
    assert.match(response.headers.get('content-range'), /^bytes 0-127\//);
    const invalid = await fetch(base + job.resultUrl, { headers: { Range: 'bytes=999999999-' } }); assert.equal(invalid.status, 416);
    const suffix = await fetch(base + job.resultUrl, { headers: { Range: 'bytes=-32' } }); assert.equal((await suffix.arrayBuffer()).byteLength, 32);
    const download = await fetch(base + job.resultUrl + '?download', { method: 'HEAD' });
    assert.match(download.headers.get('content-disposition'), /^attachment/);
    return { rangeBytes: 128, suffixBytes: 32 };
  });
  await check('cross-origin writes rejected and preview served', async () => {
    const blocked = await request('/api/assets', { method: 'POST', headers: { Origin: 'http://untrusted.example' }, body: 'x' });
    assert.equal(blocked.response.status, 403);
    const page = await fetch(base + '/'); assert.equal(page.status, 200);
    assert((await page.text()).includes('Local media export'));
  });
  await check('second server refused for same SQLite directory', async () => {
    const duplicate = spawn(process.execPath, ['server/main.mjs'], { cwd: root,
      env: { ...process.env, PORT: '0', DATA_DIR: dataDir, FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe },
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    children.add(duplicate); let stderr = ''; duplicate.stderr.on('data', data => stderr += data);
    const [code] = await once(duplicate, 'exit'); children.delete(duplicate);
    assert.notEqual(code, 0); assert.match(stderr, /already owned by process/);
  });
  await check('FFmpeg failure persists as error', async () => {
    const { body: broken } = await upload(await readFile(sample), 'removed-source.mp4');
    await unlink(path.join(dataDir, 'inputs', broken.id));
    const { body: failed } = await enqueue(broken.id, 0, 2);
    assert.equal(failed.status, 'queued');
    assert.equal((await fetch(base + `/api/jobs/${failed.id}/result`)).status, 409);
    const result = await waitFor(failed.id, ['error']);
    assert.match(result.error, /FFmpeg/);
    assert.deepEqual(result.events.map(e => e.status), ['queued', 'working', 'error']);
    assert(!existsSync(path.join(dataDir, 'outputs', failed.id + '.mp4')));
    return { states: result.events.map(e => e.status) };
  });
  let recoveredId, queuedId;
  await check('hard process kill recovers working and queued jobs', async () => {
    const interrupted = await enqueue(asset.id, 0, 8); recoveredId = interrupted.body.id;
    const observed = await waitFor(recoveredId, ['working']); assert.equal(observed.attempts, 1);
    const partial = path.join(dataDir, 'partial', recoveredId + '-1.mp4');
    let partialBytes = 0;
    const deadline = performance.now() + 10000;
    while (!partialBytes && performance.now() < deadline) {
      partialBytes = (await stat(partial).catch(() => ({ size: 0 }))).size;
      if (!partialBytes) await sleep(5);
    }
    assert(partialBytes > 0, 'FFmpeg must have opened a real output before the process is killed.');
    assert.equal((await request('/api/jobs/' + recoveredId)).body.status, 'working');
    const queued = await enqueue(asset.id, 3, 2); queuedId = queued.body.id;
    assert.equal(queued.body.status, 'queued');
    await stop('SIGKILL');
    await launch();
    const recovered = await waitFor(recoveredId, ['completed', 'error']);
    const backlog = await waitFor(queuedId, ['completed', 'error']);
    assert.equal(recovered.status, 'completed', recovered.error); assert.equal(backlog.status, 'completed', backlog.error);
    assert.equal(recovered.attempts, 2);
    assert.deepEqual(recovered.events.map(e => e.status), ['queued', 'working', 'queued', 'working', 'completed']);
    assert(recovered.events.some(e => e.reason === 'Recovered after process restart'));
    return { attempts: recovered.attempts, states: recovered.events.map(e => e.status), queuedJobRecovered: true, partialBytesBeforeKill: partialBytes };
  });
  await check('idempotency survives restart and completed jobs persist', async () => {
    const replay = await enqueue(asset.id, 1, 2, key);
    assert.equal(replay.body.id, job.id); assert.equal(replay.body.status, 'completed');
    const { body: jobs } = await request('/api/jobs'); assert.equal(jobs.length, 4);
    return { persistedJobs: jobs.length, duplicateExports: 0 };
  });
  await check('missing completed output detected on restart', async () => {
    await stop(); await unlink(path.join(dataDir, 'outputs', queuedId + '.mp4')); await launch();
    const result = await waitFor(queuedId, ['error']); assert.match(result.error, /missing/);
    return { state: result.status };
  });
} catch (e) { failure = e; }
finally {
  for (const child of children) {
    if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
  }
  const version = async file => (await exec(file, ['-version'], { windowsHide: true })).stdout.split('\n')[0].trim();
  const report = { recordedAt: new Date().toISOString(), purpose: 'Sundream local editing infrastructure work sample',
    node: process.version, ffmpeg: { path: ffmpeg, version: await version(ffmpeg) },
    ffprobe: { path: ffprobe, version: await version(ffprobe) },
    command: 'npm run build && npm test', elapsedMs: Math.round(performance.now() - began),
    passed: measured.filter(r => r.pass).length, failed: measured.filter(r => !r.pass).length,
    checks: measured, dataDirectory: path.relative(root, dataDir), serversStopped: children.size === 0,
    notTested: ['Multi-machine scheduling', 'Power loss or disk failure', 'Hostile media fuzzing', 'Large uploads near 32 MiB limit', 'Browser matrix', 'Generation provider integration'] };
  await mkdir(path.join(root, 'evidence'), { recursive: true });
  await writeFile(path.join(root, 'evidence', 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, elapsedMs: report.elapsedMs, serversStopped: report.serversStopped, report: 'evidence/results.json' }));
}
if (failure) { console.error(failure.message); process.exitCode = 1; }
