// Node 24. Tests the actual app with loopback fault injection and separate runtime data.
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const script = fileURLToPath(import.meta.url);
const work = path.resolve(path.dirname(script), '..');
const repro = work;
const main = path.join(repro, 'server', 'main.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = promisify(execFile);

// Windows child.kill('SIGTERM') forcibly terminates a process. Private IPC instead
// invokes the actual app's signal handler so the restart can honestly be called clean.
if (process.argv[2] === '--owned-server') {
  const token = process.env.RETRY_SHUTDOWN_TOKEN;
  process.on('message', message => {
    if (message?.type === 'retry-contract-stop' && message.token === token)
      process.emit('SIGTERM');
  });
  process.on('disconnect', () => process.emit('SIGTERM'));
  await import(pathToFileURL(main).href);
} else {
  await run();
}

async function run() {
  const began = performance.now(), recordedAt = new Date().toISOString();
  const checks = [], cleanupErrors = [], roots = [], transports = new Set();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(new Error('180-second suite deadline exceeded.')), 180000);
  let evidence, dataDir, server, base, proxy, proxyBase, browser, browserServer, browserVersion;
  let failure, fault = null;
  const forwards = [], pageErrors = [], serverLogs = [];
  const ffmpeg = process.env.FFMPEG_PATH, ffprobe = process.env.FFPROBE_PATH;
  const sample = path.join(repro, 'samples', 'pendulum.mp4');

  function remaining() {
    abort.signal.throwIfAborted();
    return Math.max(1, 180000 - Math.round(performance.now() - began));
  }
  async function bounded(promise, ms, name) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out (${ms}ms).`)), ms);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function check(name, fn) {
    const started = performance.now();
    try {
      remaining();
      const details = await fn();
      checks.push({ ...details, name, status: 'passed', elapsedMs: Math.round(performance.now() - started) });
    } catch (error) {
      checks.push({ name, status: 'failed', elapsedMs: Math.round(performance.now() - started), error: error.message });
      throw error;
    }
  }
  function own(child, kind) {
    const record = { child, kind, pid: child.pid, startedAt: new Date().toISOString(), exit: null };
    roots.push(record);
    child.once('exit', (code, signal) => { record.exit = { code, signal }; });
    return record;
  }
  function alive(child) { return child && child.exitCode === null && child.signalCode === null; }

  // Read-only process identity snapshots. Cleanup never targets a process name or
  // all Node/Chrome processes, and checks creation time before killing leftovers.
  async function windowsTree(record, known = []) {
    if (!record.pid) return [];
    const command = [
      '$ErrorActionPreference = "Stop"',
      '$all = @(Get-CimInstance Win32_Process)',
      '$ids = [System.Collections.Generic.HashSet[int]]::new()',
      'foreach ($id in $env:RETRY_OWNED_PIDS.Split(",")) { [void]$ids.Add([int]$id) }',
      '$changed = $true',
      'while ($changed) { $changed = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { [void]$ids.Add([int]$p.ProcessId); $changed = $true } } }',
      '$rows = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; created = $_.CreationDate.ToUniversalTime().ToString("o"); executable = $_.ExecutablePath } })',
      'ConvertTo-Json -InputObject $rows -Compress'
    ].join('\n');
    const { stdout } = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, RETRY_OWNED_PIDS: [record.pid, ...known.map(p => p.pid)].join(',') }, windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024
    });
    return JSON.parse(stdout.trim() || '[]');
  }
  async function reap(record, clean = false) {
    const wasAlive = alive(record.child);
    const tree = process.platform === 'win32' && wasAlive ? await windowsTree(record) : [];
    if (wasAlive) {
      if (clean) {
        await new Promise((resolve, reject) => record.child.send(
          { type: 'retry-contract-stop', token: record.token }, error => error ? reject(error) : resolve()));
      } else if (record.kind === 'server' && record.child.connected) {
        record.child.send({ type: 'retry-contract-stop', token: record.token }, () => {});
      } else record.child.kill('SIGTERM');
      const until = performance.now() + 8000;
      while (alive(record.child) && performance.now() < until) await sleep(40);
      if (alive(record.child)) {
        if (process.platform === 'win32') {
          await exec('taskkill.exe', ['/PID', String(record.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
        } else process.kill(-record.pid, 'SIGKILL');
        await bounded(new Promise(resolve => {
          if (!alive(record.child)) resolve(); else record.child.once('exit', resolve);
        }), 4000, 'Owned process exit after forced cleanup');
        if (clean) throw new Error('Clean restart required forceful cleanup.');
      }
    }
    if (process.platform === 'win32' && tree.length) {
      // Query by the old root also finds descendants whose parent exited first.
      const current = await windowsTree(record, tree);
      for (const entry of tree.slice().reverse()) {
        if (entry.pid === record.pid) continue;
        const identical = current.find(p => p.pid === entry.pid && p.created === entry.created && p.executable === entry.executable);
        if (identical) await exec('taskkill.exe', ['/PID', String(entry.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
      }
      const survivors = await windowsTree(record, tree);
      assert(!survivors.some(p => tree.some(old => old.pid === p.pid && old.created === p.created)), 'Owned descendant survived cleanup.');
    }
    assert(!alive(record.child), 'Owned root still running.');
    if (clean) assert.deepEqual(record.exit, { code: 0, signal: null }, 'Actual app must exit through its clean shutdown handler.');
    return { pid: record.pid, clean: clean && record.exit?.code === 0 };
  }

  async function launch() {
    remaining();
    const token = randomUUID();
    const child = spawn(process.execPath, [script, '--owned-server'], {
      cwd: repro, windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, PORT: '0', DATA_DIR: dataDir, FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe, RETRY_SHUTDOWN_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    server = own(child, 'server'); server.token = token;
    let stdout = '', stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    base = await bounded(new Promise((resolve, reject) => {
      child.on('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`Server exited before ready (${code}/${signal}): ${stderr}`)));
      child.stdout.on('data', chunk => {
        stdout = (stdout + chunk).slice(-16000);
        for (const line of stdout.split('\n')) {
          try {
            const ready = JSON.parse(line);
            if (ready.ready) {
              assert.equal(ready.pid, child.pid);
              const url = new URL(ready.url);
              assert.equal(url.hostname, '127.0.0.1'); assert(Number(url.port) > 0);
              resolve(ready.url);
            }
          } catch (error) { if (error instanceof assert.AssertionError) reject(error); }
        }
      });
    }), Math.min(20000, remaining()), 'Actual server readiness');
    serverLogs.push({ pid: child.pid, url: base, get stderr() { return stderr; } });
    const health = await request(base, '/api/health'); assert.equal(health.status, 200);
  }

  // Low-level HTTP with an absolute timer; ECONNRESET is observed directly and
  // cannot be confused with a synthesized "network error" inside an API mock.
  function raw(url, { method = 'GET', body, headers = {}, timeout = 10000 } = {}) {
    remaining();
    return new Promise((resolve, reject) => {
      let receivedHeaders = false, done = false;
      const req = http.request(url, { method, headers, agent: false }, response => {
        receivedHeaders = true;
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) req.destroy(new Error('Unexpectedly large HTTP response.'));
          else chunks.push(chunk);
        });
        response.on('end', () => finish(null, { status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
        response.on('error', finish);
        response.on('aborted', () => finish(new Error('HTTP response aborted.')));
      });
      transports.add(req);
      const timer = setTimeout(() => req.destroy(new Error('HTTP absolute deadline exceeded.')), Math.min(timeout, remaining()));
      const onAbort = () => req.destroy(abort.signal.reason);
      abort.signal.addEventListener('abort', onAbort, { once: true });
      function finish(error, value) {
        if (done) return; done = true; clearTimeout(timer); transports.delete(req);
        abort.signal.removeEventListener('abort', onAbort);
        if (error) { error.receivedHeaders = receivedHeaders; reject(error); } else resolve(value);
      }
      req.on('error', finish);
      req.end(body);
    });
  }
  async function request(origin, route, options) {
    const response = await raw(origin + route, options);
    return { ...response, body: JSON.parse(response.bytes.toString('utf8')) };
  }
  function enqueue(origin, payload, key) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (key !== undefined) headers['Idempotency-Key'] = key;
    return request(origin, '/api/jobs', { method: 'POST', headers, body });
  }
  async function jobs() { const reply = await request(base, '/api/jobs'); assert.equal(reply.status, 200); return reply.body; }
  async function completed(id) {
    const until = performance.now() + Math.min(30000, remaining());
    while (performance.now() < until) {
      const reply = await request(base, '/api/jobs/' + id); assert.equal(reply.status, 200);
      assert.notEqual(reply.body.status, 'error', reply.body.error || 'Export failed.');
      if (reply.body.status === 'completed') return reply.body;
      await sleep(100);
    }
    throw new Error(`Export ${id} did not complete within 30 seconds.`);
  }
  async function outputFiles() { return (await readdir(path.join(dataDir, 'outputs'))).filter(name => name.endsWith('.mp4')).sort(); }
  function armLoss() {
    assert.equal(fault, null, 'Only one fault may be armed.');
    let resolve, reject;
    const consumed = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Attach a handler immediately, before the HTTP request starts.
    consumed.catch(() => {});
    fault = { resolve, reject };
    return consumed;
  }
  async function startProxy() {
    proxy = http.createServer((req, res) => {
      const dropping = req.method === 'POST' && req.url === '/api/jobs' ? fault : null;
      if (dropping) fault = null;
      const isJob = req.method === 'POST' && req.url === '/api/jobs';
      const record = isJob ? { key: req.headers['idempotency-key'], body: '', dropped: Boolean(dropping) } : null;
      if (record) { forwards.push(record); req.on('data', chunk => { record.body += chunk; }); }
      const headers = { ...req.headers, host: new URL(base).host, connection: 'close' };
      if (headers.origin === proxyBase) headers.origin = base;
      const upstream = http.request(base + req.url, { method: req.method, headers, agent: false }, response => {
        if (record) { record.status = response.statusCode; record.replayed = response.headers['idempotency-replayed'] || null; }
        if (dropping) {
          const chunks = []; let bytes = 0;
          response.on('data', chunk => {
            bytes += chunk.length; chunks.push(chunk);
            if (bytes > 65536) upstream.destroy(new Error('Fault response exceeded 64 KiB.'));
          });
          response.on('end', () => {
            try {
              const job = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const receipt = { upstreamStatus: response.statusCode, consumedBytes: bytes, job, clientHeadersSent: res.headersSent, key: record.key, body: record.body };
              record.consumed = receipt;
              // The actual successful response has ended; zero bytes reach the client.
              res.socket?.destroy(); dropping.resolve(receipt);
            } catch (error) { dropping.reject(error); res.destroy(); }
          });
          response.on('error', error => { dropping.reject(error); res.destroy(); });
        } else { res.writeHead(response.statusCode, response.headers); response.pipe(res); }
      });
      transports.add(upstream);
      const timer = setTimeout(() => upstream.destroy(new Error('Proxy upstream deadline exceeded.')), 20000);
      upstream.on('close', () => { clearTimeout(timer); transports.delete(upstream); });
      upstream.on('error', error => { dropping?.reject(error); res.destroy(); });
      req.on('error', error => upstream.destroy(error));
      req.pipe(upstream);
    });
    proxy.on('connection', socket => { transports.add(socket); socket.once('close', () => transports.delete(socket)); });
    proxy.requestTimeout = 20000; proxy.headersTimeout = 10000;
    await bounded(new Promise((resolve, reject) => {
      proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve);
    }), 5000, 'Loopback fault proxy listen');
    proxyBase = `http://127.0.0.1:${proxy.address().port}`;
  }

  try {
    const runId = `retry-contract-${recordedAt.replace(/[:.]/g, '-')}-${randomUUID()}`;
    await mkdir(path.join(work, 'evidence'), { recursive: true });
    evidence = path.join(work, 'evidence', runId);
    await mkdir(evidence, { recursive: false });
    await check('prerequisites, short isolated DATA_DIR and actual server startup', async () => {
      assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Run this harness with Node 24.');
      for (const [name, executable] of [['FFMPEG_PATH', ffmpeg], ['FFPROBE_PATH', ffprobe]]) {
        assert(executable && path.isAbsolute(executable), `${name} must be a supplied full executable path.`);
        assert((await stat(executable)).isFile(), `${name} is not a file.`);
      }
      assert((await stat(path.join(repro, 'node_modules'))).isDirectory(), 'Install app dependencies first.');
      assert((await stat(path.join(repro, 'dist', 'index.html'))).isFile(), 'Build the UI first.');
      const tempRoot = path.resolve(process.env.TEST_DATA_ROOT || os.tmpdir());
      assert(tempRoot.length < 110, 'Use a short TEST_DATA_ROOT to leave room for SQLite and output filenames on Windows.');
      await mkdir(tempRoot, { recursive: true });
      dataDir = await mkdtemp(path.join(tempRoot, 'md-retry-'));
      assert(dataDir.length + 80 < 240, 'Generated database/media paths must remain short.');
      const versions = {};
      for (const [name, executable] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) {
        versions[name] = (await exec(executable, ['-version'], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 })).stdout.split('\n')[0].trim();
      }
      const bytes = await readFile(sample);
      assert(bytes.length > 0 && bytes.length < 32 * 1024 * 1024);
      await launch(); await startProxy();
      assert.equal((await jobs()).length, 0);
      return { node: process.version, versions, dataDirectory: dataDir, sampleBytes: bytes.length,
        sampleSha256: createHash('sha256').update(bytes).digest('hex'), server: base, proxy: proxyBase };
    });
    let asset;
    await check('upload existing authored sample to actual server', async () => {
      const bytes = await readFile(sample);
      const reply = await request(base, '/api/assets', { method: 'POST', timeout: 20000,
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'pendulum.mp4', 'Content-Length': bytes.length }, body: bytes });
      assert.equal(reply.status, 201); assert(reply.body.duration >= 2); asset = reply.body;
      return { assetId: asset.id, durationSeconds: asset.duration, width: asset.width, height: asset.height };
    });
    const key = randomUUID();
    const payload = JSON.stringify({ assetId: asset.id, start: 1, duration: 0.4 });
    let first, second, concurrent;
    await check('missing key rejects with 400 and creates zero jobs', async () => {
      const reply = await enqueue(base, payload);
      assert.equal(reply.status, 400); assert.equal((await jobs()).length, 0);
      return { httpStatus: reply.status, jobs: 0 };
    });
    await check('consumed success then connection reset: same-key retry recovers one job and one export', async () => {
      const consumed = armLoss();
      let lost;
      try { await enqueue(proxyBase, payload, key); } catch (error) { lost = error; }
      assert(lost, 'Client must receive a transport failure.');
      assert.equal(lost.code, 'ECONNRESET'); assert.equal(lost.receivedHeaders, false);
      const receipt = await bounded(consumed, 10000, 'Proxy fully consumed success');
      assert.equal(receipt.upstreamStatus, 202); assert.equal(receipt.clientHeadersSent, false);
      assert(receipt.consumedBytes > 0); first = receipt.job;
      const accepted = await jobs(); assert.equal(accepted.length, 1); assert.equal(accepted[0].id, first.id);
      const retry = await enqueue(proxyBase, payload, key);
      assert.equal(retry.status, 200); assert.equal(retry.headers['idempotency-replayed'], 'true');
      assert.equal(retry.body.id, first.id); assert.equal((await jobs()).length, 1);
      first = await completed(first.id);
      assert.equal(first.attempts, 1);
      assert.deepEqual(first.events.map(e => e.status), ['queued', 'working', 'completed']);
      assert.deepEqual(await outputFiles(), [first.id + '.mp4']);
      return { key, clientError: lost.code, upstreamStatus: receipt.upstreamStatus, consumedBytes: receipt.consumedBytes,
        clientReceivedResponseHeaders: false, replayStatus: retry.status, jobId: first.id, jobs: 1, exports: 1, attempts: first.attempts };
    });
    await check('fresh key with identical body creates a distinct second job and export', async () => {
      const newKey = randomUUID(); const reply = await enqueue(proxyBase, payload, newKey);
      assert.equal(reply.status, 202); assert.notEqual(reply.body.id, first.id);
      assert.equal((await jobs()).length, 2); second = await completed(reply.body.id);
      assert.equal(second.attempts, 1);
      assert.deepEqual(await outputFiles(), [first.id + '.mp4', second.id + '.mp4'].sort());
      return { originalKey: key, newKey, firstJob: first.id, secondJob: second.id, jobs: 2, exports: 2 };
    });
    await check('same key with changed body returns 409 without creating a job', async () => {
      const reply = await enqueue(base, { assetId: asset.id, start: 1.1, duration: 0.4 }, key);
      assert.equal(reply.status, 409); assert.equal((await jobs()).length, 2);
      return { httpStatus: reply.status, jobs: 2, error: reply.body.error };
    });
    await check('eight concurrent identical same-key submissions create one job', async () => {
      const sharedKey = randomUUID();
      const responses = await Promise.all(Array.from({ length: 8 }, () => enqueue(base, payload, sharedKey)));
      assert.equal(new Set(responses.map(r => r.body.id)).size, 1);
      assert.equal(responses.filter(r => r.status === 202).length, 1);
      assert.equal(responses.filter(r => r.status === 200 && r.headers['idempotency-replayed'] === 'true').length, 7);
      assert.equal((await jobs()).length, 3);
      concurrent = await completed(responses[0].body.id); assert.equal(concurrent.attempts, 1);
      assert.equal((await outputFiles()).length, 3);
      return { key: sharedKey, requests: 8, accepted: 1, replayed: 7, distinctJobs: 1, jobId: concurrent.id, totalJobs: 3 };
    });
    await check('all three small real MP4 outputs probe and decode', async () => {
      const outputs = [];
      for (const job of [first, second, concurrent]) {
        const file = path.join(dataDir, 'outputs', job.id + '.mp4');
        const { stdout } = await exec(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
          { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 });
        const info = JSON.parse(stdout);
        assert(Math.abs(Number(info.format.duration) - job.duration) <= 0.15);
        assert.equal(info.streams.find(s => s.codec_type === 'video')?.codec_name, 'h264');
        assert.equal(info.streams.find(s => s.codec_type === 'audio')?.codec_name, 'aac');
        await exec(ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'],
          { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
        outputs.push({ jobId: job.id, bytes: (await stat(file)).size, durationSeconds: Number(info.format.duration), fullDecode: true });
      }
      return { outputs };
    });
    await check('same-key replay survives an actual clean server restart', async () => {
      const before = await jobs(), files = await outputFiles(), previous = server;
      assert.equal((await request(base, '/api/health')).body.worker, 'idle');
      const stopped = await reap(previous, true); await launch();
      assert.notEqual(server.pid, previous.pid);
      const reply = await enqueue(proxyBase, payload, key);
      assert.equal(reply.status, 200); assert.equal(reply.headers['idempotency-replayed'], 'true');
      assert.deepEqual(reply.body, first);
      assert.deepEqual((await jobs()).map(j => j.id).sort(), before.map(j => j.id).sort());
      assert.deepEqual(await outputFiles(), files);
      return { oldPid: previous.pid, newPid: server.pid, cleanExit: stopped.clean, persistedJobId: reply.body.id, jobs: 3, exports: files.length };
    });

    if (!process.env.PLAYWRIGHT_MODULE) {
      checks.push({ name: 'local built React UI retry across reload', status: 'skipped', reason: 'PLAYWRIGHT_MODULE was not supplied; no UI success is claimed.' });
    } else {
      let chromium;
      try {
        ({ chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href));
        browserServer = await chromium.launchServer({ headless: true, host: '127.0.0.1', port: 0, timeout: 15000 });
        own(browserServer.process(), 'headless-browser');
        browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 10000 });
        browserVersion = browser.version();
      } catch (error) {
        checks.push({ name: 'headless browser availability', status: 'skipped', reason: error.message, backendOnly: true });
      }
      if (browser) await check('actual local React UI retains key/body after lost response and reload, then retries one job', async () => {
        const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1000, height: 900 } });
        await context.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin === proxyBase) return route.continue();
          return route.abort('blockedbyclient');
        });
        const page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000);
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(proxyBase);
        await page.getByRole('heading', { name: 'Media export', exact: true }).waitFor();
        await page.getByLabel('Import video').setInputFiles(sample);
        await page.getByRole('status').filter({ hasText: 'Imported pendulum.mp4.' }).waitFor();
        const selectedAsset = await page.getByRole('combobox', { name: 'Source', exact: true }).inputValue();
        await page.getByLabel('Start (seconds)').fill('1');
        await page.getByLabel('Duration (seconds)').fill('0.4');
        const before = (await jobs()).length, offset = forwards.length, consumed = armLoss();
        await page.getByRole('button', { name: 'Queue MP4 export' }).click();
        const receipt = await bounded(consumed, 10000, 'UI proxy consumed successful submission');
        assert.equal(receipt.upstreamStatus, 202); assert.equal(receipt.clientHeadersSent, false);
        await page.getByRole('alert').waitFor();
        const pending = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pending-export')));
        assert.equal(pending.key, receipt.key); assert.equal(pending.signature, receipt.body);
        assert.equal((await jobs()).length, before + 1);
        await page.reload();
        await page.getByRole('combobox', { name: 'Source', exact: true }).selectOption(selectedAsset);
        await page.getByLabel('Start (seconds)').fill('1');
        await page.getByLabel('Duration (seconds)').fill('0.4');
        assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('pending-export'))), pending);
        const responsePromise = page.waitForResponse(response => response.url() === proxyBase + '/api/jobs' && response.request().method() === 'POST');
        await page.getByRole('button', { name: 'Queue MP4 export' }).click();
        const reply = await responsePromise;
        assert.equal(reply.status(), 200); assert.equal(reply.headers()['idempotency-replayed'], 'true');
        assert.equal((await reply.json()).id, receipt.job.id);
        await page.waitForFunction(() => sessionStorage.getItem('pending-export') === null);
        const submissions = forwards.slice(offset); assert.equal(submissions.length, 2);
        assert.equal(submissions[0].key, submissions[1].key); assert.equal(submissions[0].body, submissions[1].body);
        const job = await completed(receipt.job.id); assert.equal(job.attempts, 1);
        assert.equal((await jobs()).length, before + 1); assert.equal((await outputFiles()).length, before + 1);
        assert.deepEqual(pageErrors, []);
        await page.screenshot({ path: path.join(evidence, 'ui-retry-after-reload.png'), fullPage: true, timeout: 10000 });
        await context.close();
        return { browser: browserVersion, sourceReselectedAfterReload: true, persistedKey: pending.key, payload: JSON.parse(pending.signature),
          successfulResponseConsumedBeforeDisconnect: true, replayStatus: reply.status(), jobId: job.id, submissions: 2,
          jobsAdded: 1, outputFilesAdded: 1, attempts: job.attempts, pageErrors: [], screenshot: 'ui-retry-after-reload.png' };
      });
      async function localPage(storageMode = null) {
        const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width:1000, height:900 } });
        await context.route('**/*', route => new URL(route.request().url()).origin === proxyBase ? route.continue() : route.abort('blockedbyclient'));
        if (storageMode) await context.addInitScript(mode => {
          window.__retryStorageFailure = mode;
          for (const operation of ['setItem','removeItem']) {
            const original = Storage.prototype[operation];
            Storage.prototype[operation] = function(key, ...args) {
              if (key === 'pending-export' && window.__retryStorageFailure === operation) throw new DOMException('Injected storage failure', 'QuotaExceededError');
              return original.call(this, key, ...args);
            };
          }
        }, storageMode);
        const page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000);
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(proxyBase);
        await page.getByLabel('Import video').setInputFiles(sample);
        await page.getByRole('status').filter({ hasText:'Imported pendulum.mp4.' }).waitFor();
        await page.getByLabel('Start (seconds)').fill('1');
        await page.getByLabel('Duration (seconds)').fill('0.4');
        return { context, page };
      }
      if (browser) await check('changed form cannot replace unresolved identity and restore button recovers original action', async () => {
        const { context,page } = await localPage();
        try {
          const before = (await jobs()).length, offset = forwards.length, consumed = armLoss();
          await page.getByRole('button',{name:'Queue MP4 export'}).click();
          const receipt = await bounded(consumed,10000,'Changed-intent setup response loss');
          await page.getByRole('alert').waitFor();
          const pending = await page.evaluate(() => sessionStorage.getItem('pending-export'));
          await page.getByLabel('Duration (seconds)').fill('0.6');
          await page.getByRole('button',{name:'Queue MP4 export'}).click();
          await page.getByRole('alert').filter({hasText:'Restore and retry it before starting another export'}).waitFor();
          assert.equal(forwards.length,offset + 1); assert.equal((await jobs()).length,before + 1);
          assert.equal(await page.evaluate(() => sessionStorage.getItem('pending-export')),pending);
          const sourcePreview = page.getByLabel('Source video preview');
          await sourcePreview.evaluate(async video => { video.muted = true; await video.play(); video.pause(); video.currentTime = 1; });
          await page.waitForFunction(() => { const video = document.querySelector('video'); return video?.readyState >= 2 && !video.seeking && video.currentTime >= 1; });
          await page.locator('section').first().screenshot({path:path.join(evidence,'changed-form-retains-original.png')});
          await page.getByRole('button',{name:'Restore pending export',exact:true}).click();
          assert.equal(await page.getByLabel('Duration (seconds)').inputValue(),'0.4');
          const responsePromise = page.waitForResponse(r => r.url() === proxyBase + '/api/jobs' && r.request().method() === 'POST');
          await page.getByRole('button',{name:'Queue MP4 export'}).click();
          const response = await responsePromise;
          assert.equal(response.status(),200); assert.equal((await response.json()).id,receipt.job.id);
          await page.waitForFunction(() => sessionStorage.getItem('pending-export') === null);
          assert.equal((await jobs()).length,before + 1); assert.equal(forwards.length,offset + 2);
          assert.equal(forwards[offset].key,forwards[offset + 1].key);
          await completed(receipt.job.id);
          return {key:receipt.key,jobId:receipt.job.id,changedAttemptSent:false,originalValuesRestored:true,jobsAdded:1};
        } finally { await context.close(); }
      });
      if (browser) await check('storage write failure sends no POST and always releases busy state', async () => {
        const {context,page} = await localPage('setItem');
        try {
          const before = (await jobs()).length, offset = forwards.length;
          await page.getByRole('button',{name:'Queue MP4 export'}).click();
          await page.getByRole('alert').filter({hasText:'no export request was sent'}).waitFor();
          assert(await page.getByRole('button',{name:'Queue MP4 export'}).isEnabled());
          assert.equal(forwards.length,offset); assert.equal((await jobs()).length,before);
          await page.evaluate(() => { window.__retryStorageFailure = null; });
          await page.getByRole('button',{name:'Queue MP4 export'}).click();
          await page.getByRole('status').filter({hasText:'Export accepted.'}).waitFor();
          assert.equal(forwards.length,offset + 1); assert.equal((await jobs()).length,before + 1);
          await completed((await jobs())[0].id);
          return {injectedFailure:'QuotaExceededError on setItem',postsWhileStorageFailed:0,busyReleased:true,recoveryJobsAdded:1};
        } finally { await context.close(); }
      });
      if (browser) await check('storage removal failure does not report accepted export as failed or lose its key', async () => {
        const {context,page} = await localPage('removeItem');
        try {
          const before = (await jobs()).length, offset = forwards.length;
          await page.getByRole('button',{name:'Queue MP4 export'}).click();
          await page.getByRole('status').filter({hasText:'Export accepted. Saved retry details could not be cleared'}).waitFor();
          assert.equal(await page.getByRole('alert').count(),0);
          const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pending-export')));
          assert(saved.key); assert(await page.getByRole('button',{name:'Queue MP4 export'}).isEnabled());
          await page.evaluate(() => { window.__retryStorageFailure = null; });
          await page.getByRole('button',{name:'Queue MP4 export'}).click();
          await page.waitForFunction(() => sessionStorage.getItem('pending-export') === null);
          assert.equal(forwards.length,offset + 2); assert.equal(forwards[offset].key,forwards[offset + 1].key);
          assert.equal(forwards[offset + 1].status,200); assert.equal((await jobs()).length,before + 1);
          await completed((await jobs())[0].id);
          return {acceptedWasNotShownAsFailed:true,retainedKey:saved.key,replayStatus:200,jobsAdded:1};
        } finally { await context.close(); }
      });
      if (browser) await check('wrong parseable acknowledgment keeps key until actual same-job replay is validated', async () => {
        const {context,page} = await localPage();
        let firstReply = true, accepted;
        try {
          await page.route('**/api/jobs',async route => {
            if (route.request().method() !== 'POST' || !firstReply) return route.continue();
            firstReply = false;
            const response = await route.fetch(); accepted = await response.json();
            assert.equal(response.status(),202);
            await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...accepted,assetId:randomUUID()})});
          });
          const before = (await jobs()).length, offset = forwards.length;
          await page.getByRole('button',{name:'Queue MP4 export'}).click();
          await page.getByRole('alert').filter({hasText:'did not acknowledge this export'}).waitFor();
          const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pending-export')));
          assert(saved.key); assert.equal((await jobs()).length,before + 1);
          await page.getByRole('button',{name:'Queue MP4 export'}).click();
          await page.waitForFunction(() => sessionStorage.getItem('pending-export') === null);
          assert.equal(forwards.length,offset + 2); assert.equal(forwards[offset].key,forwards[offset + 1].key);
          assert.equal(forwards[offset + 1].status,200); assert.equal((await jobs()).length,before + 1);
          assert.equal((await completed(accepted.id)).id,accepted.id); assert.deepEqual(pageErrors,[]);
          return {injectedAcknowledgment:'2xx JSON with wrong assetId after actual server accepted',retainedKey:saved.key,jobId:accepted.id,jobsAdded:1,noPageErrors:true};
        } finally { await context.close(); }
      });
    }
  } catch (error) { failure = error; }
  finally {
    clearTimeout(deadline);
    if (browser) try { await bounded(browser.close(), 8000, 'Browser connection close'); } catch (error) { cleanupErrors.push(error.message); }
    if (browserServer) try { await bounded(browserServer.close(), 8000, 'Owned headless browser close'); } catch (error) { cleanupErrors.push(error.message); }
    for (const transport of transports) transport.destroy();
    if (proxy) try {
      await bounded(new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); }), 4000, 'Owned proxy close');
    } catch (error) { cleanupErrors.push(error.message); }
    for (const record of roots.slice().reverse()) {
      try { await reap(record); } catch (error) { cleanupErrors.push(`${record.kind} ${record.pid}: ${error.message}`); }
    }
    const failed = checks.filter(c => c.status === 'failed').length;
    const allPassed = !failure && !failed && !cleanupErrors.length && checks.every(c => ['passed', 'skipped'].includes(c.status));
    const report = {
      schemaVersion: 1, recordedAt, finishedAt: new Date().toISOString(), purpose: 'Master.dev local retry contract regression',
      outcome: allPassed ? 'passed' : 'failed', processExitCode: allPassed ? 0 : 1,
      elapsedMs: Math.round(performance.now() - began), node: process.version, script, actualServerSource: main,
      binaries: { ffmpeg, ffprobe }, dataDirectory: dataDir || null, evidenceDirectory: evidence || null,
      runtimeDataPreserved: Boolean(dataDir), checks, passed: checks.filter(c => c.status === 'passed').length,
      failed, skipped: checks.filter(c => c.status === 'skipped').length,
      failure: failure ? { message: failure.message, stack: failure.stack } : null,
      cleanup: { roots: roots.map(r => ({ kind: r.kind, pid: r.pid, exit: r.exit, stillRunning: alive(r.child) })),
        proxyStopped: !proxy?.listening, errors: cleanupErrors,
        ownedRootsStopped: roots.every(r => !alive(r.child)) && cleanupErrors.length === 0 },
      faultProxySubmissions: forwards, serverLogs,
      limits: [
        'Submission deduplication is not exactly-once execution. This suite does not interrupt a working render or prove crash-safe output publication.',
        'Clean restart replay is tested with completed jobs, one loopback Node process, one local SQLite directory and one worker.',
        'Fresh-key identical-body submission intentionally creates another job; identity follows the retained key, not similarity of user intent.',
        'The UI check covers identical payload retry after reload with the source/time window manually restored; it does not validate changed-intent recovery or storage failures.',
        'No distributed execution, remote provider, real user browser, external accounts, publication, private client work or production deployment is exercised.',
      ]
    };
    if (evidence) {
      try { await writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
      catch (error) { cleanupErrors.push('Report write failed: ' + error.message); report.outcome = 'failed'; report.processExitCode = 1; }
    }
    console.log(JSON.stringify({ outcome: report.outcome, exitCode: report.processExitCode, passed: report.passed, failed, skipped: report.skipped,
      ownedRootsStopped: report.cleanup.ownedRootsStopped, report: evidence ? path.join(evidence, 'results.json') : null, dataDirectory: dataDir || null }));
    if (failure) console.error(failure.message);
    for (const error of cleanupErrors) console.error(error);
    process.exitCode = report.processExitCode;
  }
}
