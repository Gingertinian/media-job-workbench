import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, createReadStream, createWriteStream } from 'node:fs';
import { rename, unlink, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { binary } from './runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
for (const dir of ['inputs', 'outputs', 'partial']) mkdirSync(path.join(dataDir, dir), { recursive: true });
const ffmpeg = binary('ffmpeg'), ffprobe = binary('ffprobe');
const db = new DatabaseSync(path.join(dataDir, 'jobs.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, duration REAL NOT NULL,
    width INTEGER NOT NULL, height INTEGER NOT NULL, media_type TEXT NOT NULL, created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL,
    asset_id TEXT NOT NULL REFERENCES assets(id), start REAL NOT NULL, duration REAL NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','working','completed','error')),
    attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id), status TEXT NOT NULL, at TEXT NOT NULL, reason TEXT);`);
db.exec('BEGIN IMMEDIATE');
try {
  const owner = db.prepare('SELECT pid FROM owner WHERE id=1').get();
  if (owner) {
    let alive = false;
    try { process.kill(owner.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (alive) throw new Error(`Data directory is already owned by process ${owner.pid}.`);
  }
  db.prepare('INSERT OR REPLACE INTO owner VALUES (1, ?)').run(process.pid);
  db.exec('COMMIT');
} catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
const now = () => new Date().toISOString();
function transition(id, status, error = null, reason = null) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const at = now();
    db.prepare("UPDATE jobs SET status=?,error=?,updated=?,attempts=attempts+CASE WHEN ?='working' THEN 1 ELSE 0 END WHERE id=?")
      .run(status, error, at, status, id);
    db.prepare('INSERT INTO events(job_id,status,at,reason) VALUES (?,?,?,?)').run(id, status, at, reason);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
for (const job of db.prepare("SELECT * FROM jobs WHERE status='working'").all())
  transition(job.id, 'queued', null, 'Recovered after process restart');
for (const job of db.prepare("SELECT * FROM jobs WHERE status='completed'").all())
  if (!existsSync(path.join(dataDir, 'outputs', job.id + '.mp4')))
    transition(job.id, 'error', 'Completed output file is missing.', 'File check at startup');

const execute = promisify(execFile);
async function probe(file) {
  const { stdout } = await execute(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-format_whitelist', 'mov,matroska,webm',
    '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  const metadata = JSON.parse(stdout);
  const video = metadata.streams.find(stream => stream.codec_type === 'video');
  const duration = Number(metadata.format?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0 || duration > 600 ||
    video.width < 2 || video.height < 2 || video.width * video.height > 3840 * 2160)
    throw new Error('Use a video up to 10 minutes and 3840 x 2160.');
  return { duration, width: video.width, height: video.height,
    media_type: metadata.format.format_name.includes('webm') ? 'video/webm' : 'video/mp4' };
}
const jobView = row => ({ id: row.id, assetId: row.asset_id, start: row.start, duration: row.duration,
  status: row.status, attempts: row.attempts, error: row.error, created: row.created, updated: row.updated,
  resultUrl: row.status === 'completed' ? `/api/jobs/${row.id}/result` : null,
  events: db.prepare('SELECT status,at,reason FROM events WHERE job_id=? ORDER BY seq').all(row.id) });
let active = null, closing = false;
function work() {
  if (active || closing) return;
  const job = db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY created,id LIMIT 1").get();
  if (!job) return;
  transition(job.id, 'working');
  const target = path.join(dataDir, 'partial', `${job.id}-${job.attempts + 1}.mp4`);
  const child = fork(fileURLToPath(new URL('./render.mjs', import.meta.url)), [],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  active = child;
  let settled = false;
  async function finish(message) {
    if (settled) return;
    settled = true;
    try {
      if (closing) { transition(job.id, 'queued', null, 'Server stopped during export'); }
      else if (message.ok) {
        const info = await probe(target);
        if (Math.abs(info.duration - job.duration) > 0.25) throw new Error('Output duration failed validation.');
        await rename(target, path.join(dataDir, 'outputs', job.id + '.mp4'));
        transition(job.id, 'completed');
      } else transition(job.id, 'error', 'FFmpeg could not export this input. ' + (message.detail || '').slice(-500));
    } catch (e) { transition(job.id, 'error', e.message); }
    finally {
      await unlink(target).catch(() => {});
      if (child.connected) child.disconnect();
      child.kill(); active = null;
      if (closing) await closeDatabase(); else setImmediate(work);
    }
  }
  child.on('message', finish);
  child.on('error', error => finish({ ok: false, detail: error.message }));
  child.on('exit', () => finish({ ok: false, detail: 'Export worker stopped.' }));
  child.send({ ffmpeg, source: path.join(dataDir, 'inputs', job.asset_id), target, start: job.start, duration: job.duration });
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new HttpError(413, 'Request too large.'); }
  try { return JSON.parse(body); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}
async function sendFile(req, res, file, type) {
  const { size } = await stat(file);
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  await pipeline(createReadStream(file, { start, end }), res);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (!['localhost', '127.0.0.1'].includes((req.headers.host || '').split(':')[0]))
      throw new HttpError(403, 'Local access only.');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
      throw new HttpError(403, 'Use the same local origin.');
    if (req.method === 'GET' && pathname === '/api/health')
      return json(res, 200, { mode: 'local demo', ffmpeg: true, ffprobe: true, worker: active ? 'working' : 'idle' });
    if (req.method === 'GET' && pathname === '/api/assets')
      return json(res, 200, db.prepare('SELECT * FROM assets ORDER BY created DESC').all().map(a => ({ ...a, sourceUrl: `/api/assets/${a.id}/source` })));
    if (req.method === 'POST' && pathname === '/api/assets') {
      const id = randomUUID(), file = path.join(dataDir, 'inputs', id);
      let size = 0;
      try {
        const limit = new Transform({ transform(chunk, encoding, callback) {
          size += chunk.length; callback(size > 32 * 1024 * 1024 ? new HttpError(413, 'Upload limit is 32 MiB.') : null, chunk);
        } });
        await pipeline(req, limit, createWriteStream(file, { flags: 'wx' }));
        if (!size) throw new HttpError(400, 'Choose a nonempty video file.');
        let metadata;
        try { metadata = await probe(file); } catch { throw new HttpError(422, 'Cannot read this video. Use an MP4, MOV or WebM within the input limits.'); }
        const name = String(req.headers['x-file-name'] || 'video').replace(/[\x00-\x1f]/g, '').slice(0, 120);
        const created = now();
        db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?)').run(id, name, metadata.duration, metadata.width, metadata.height, metadata.media_type, created);
        return json(res, 201, { id, name, ...metadata, created, sourceUrl: `/api/assets/${id}/source` });
      } catch (e) { await unlink(file).catch(() => {}); throw e; }
    }
    if (req.method === 'GET' && pathname === '/api/jobs')
      return json(res, 200, db.prepare('SELECT * FROM jobs ORDER BY created DESC').all().map(jobView));
    if (req.method === 'POST' && pathname === '/api/jobs') {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new HttpError(400, 'Provide an Idempotency-Key of 8 to 100 letters, digits, underscores or hyphens.');
      const { assetId, start, duration } = await readJson(req);
      if (typeof assetId !== 'string' || !Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration < 0.1 || duration > 30)
        throw new HttpError(400, 'Choose a start >= 0 and duration from 0.1 to 30 seconds.');
      const fingerprint = createHash('sha256').update(JSON.stringify([assetId, start, duration])).digest('hex');
      const prior = db.prepare('SELECT * FROM jobs WHERE key=?').get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new HttpError(409, 'This request key already belongs to a different export.');
        res.setHeader('Idempotency-Replayed', 'true');
        return json(res, 200, jobView(prior));
      }
      const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);
      if (!asset) throw new HttpError(404, 'Source not found.');
      if (start + duration > asset.duration + 0.001) throw new HttpError(400, 'The export must fit within the source.');
      const id = randomUUID(), at = now();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO jobs (id,key,fingerprint,asset_id,start,duration,status,created,updated) VALUES (?,?,?,?,?,?,\'queued\',?,?)')
          .run(id, key, fingerprint, assetId, start, duration, at, at);
        db.prepare('INSERT INTO events(job_id,status,at) VALUES (?,\'queued\',?)').run(id, at);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      json(res, 202, jobView(db.prepare('SELECT * FROM jobs WHERE id=?').get(id)));
      setImmediate(work); return;
    }
    const match = /^\/api\/(assets|jobs)\/([a-f0-9-]{36})(?:\/(source|result))?$/.exec(pathname);
    if (match && ['GET', 'HEAD'].includes(req.method)) {
      const [, kind, id, action] = match;
      const row = db.prepare(`SELECT * FROM ${kind} WHERE id=?`).get(id);
      if (!row) throw new HttpError(404, 'Item not found.');
      if (kind === 'jobs' && !action) return json(res, 200, jobView(row));
      if (kind === 'jobs' && action === 'result') {
        if (row.status !== 'completed') throw new HttpError(409, 'Export is not completed.');
        if (url.searchParams.has('download')) res.setHeader('Content-Disposition', `attachment; filename="export-${id.slice(0, 8)}.mp4"`);
        return await sendFile(req, res, path.join(dataDir, 'outputs', id + '.mp4'), 'video/mp4');
      }
      if (kind === 'assets' && action === 'source') {
        return await sendFile(req, res, path.join(dataDir, 'inputs', id), row.media_type);
      }
    }
    if (['GET', 'HEAD'].includes(req.method)) {
      const staticPath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
      const dist = path.join(root, 'dist'), file = path.resolve(dist, staticPath);
      if (!file.startsWith(dist + path.sep) || !existsSync(file)) throw new HttpError(404, 'Not found. Build the preview with npm run build.');
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
      return await sendFile(req, res, file, types[path.extname(file)] || 'application/octet-stream');
    }
    throw new HttpError(404, 'Route not found.');
  } catch (e) {
    if (res.headersSent || res.destroyed) return res.destroy();
    json(res, e.status || (e.code === 'ENOENT' ? 404 : 500), { error: e.status ? e.message : 'Local request failed.' });
  }
});
let databaseClosed = false;
async function closeDatabase() {
  if (databaseClosed) return;
  databaseClosed = true;
  db.prepare('DELETE FROM owner WHERE id=1 AND pid=?').run(process.pid);
  db.close(); process.exit(0);
}
function stop() {
  if (closing) return;
  closing = true;
  server.close(); server.closeAllConnections();
  if (active?.connected) active.send({ stop: true }); else if (active) active.kill(); else closeDatabase();
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
server.on('error', error => { console.error(error.message); stop(); });
server.listen(Number(process.env.PORT || 4317), '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${server.address().port}`, pid: process.pid }));
  work();
});
