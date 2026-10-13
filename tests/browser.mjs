import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { binary } from '../server/runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
  : await import('playwright');
const dataDirectory = path.join(process.env.TEST_DATA_ROOT || path.join(root, 'evidence', 'browser-data'), 'browser-' + new Date().toISOString().replace(/[:.]/g, '-'));
const ffmpeg = binary('ffmpeg'), ffprobe = binary('ffprobe');
const started = performance.now(), checks = [], pageErrors = [];
let browser, failure, base;
const server = spawn(process.execPath, ['server/main.mjs'], { cwd: root,
  env: { ...process.env, PORT: '0', DATA_DIR: dataDirectory, FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
async function check(name, fn) {
  const began = performance.now();
  try { const detail = await fn(); checks.push({ name, pass: true, elapsedMs: Math.round(performance.now() - began), ...detail }); }
  catch (e) { checks.push({ name, pass: false, error: e.message }); throw e; }
}
try {
  await new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => reject(new Error('Server not ready: ' + errors)), 10000);
    server.stderr.on('data', chunk => errors += chunk);
    server.stdout.on('data', chunk => {
      output += chunk;
      const line = output.split('\n').find(l => l.includes('"ready":true'));
      if (line) { base = JSON.parse(line).url; clearTimeout(timer); resolve(); }
    });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${errors}`)); });
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base);
  await check('accessible controls and keyboard focus', async () => {
    await page.getByRole('heading', { name: 'Media export', exact: true }).waitFor();
    assert(await page.getByLabel('Import video').isVisible());
    assert(await page.getByRole('button', { name: 'Queue MP4 export' }).isDisabled());
    await page.keyboard.press('Tab');
    assert(await page.getByLabel('Import video').evaluate(element => document.activeElement === element));
    assert.equal(await page.getByLabel('Import video').evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
    return { firstTabTarget: 'Import video' };
  });
  await check('invalid media displays a readable error', async () => {
    await page.getByLabel('Import video').setInputFiles({ name: 'invalid.mp4', mimeType: 'video/mp4', buffer: Buffer.from('invalid media') });
    await page.getByRole('alert').filter({ hasText: 'Cannot read this video' }).waitFor();
  });
  await check('upload, trim and actual browser playback', async () => {
    await page.getByLabel('Import video').setInputFiles(path.join(root, 'samples', 'pendulum.mp4'));
    await page.getByRole('status').filter({ hasText: 'Imported pendulum.mp4' }).waitFor();
    const source = page.getByLabel('Source video preview');
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
    const sourceDuration = await source.evaluate(video => video.duration);
    assert.equal(sourceDuration, 8);
    await page.getByLabel('Start (seconds)').fill('1');
    await page.getByLabel('Duration (seconds)').fill('2');
    await page.getByRole('button', { name: 'Queue MP4 export' }).click();
    await page.locator('.jobs .completed').waitFor({ timeout: 20000 });
    const video = page.locator('.jobs video');
    await video.evaluate(async video => { video.muted = true; await video.play(); });
    await page.waitForFunction(() => document.querySelector('.jobs video')?.currentTime > 0.4);
    const duration = await video.evaluate(video => video.duration);
    assert(Math.abs(duration - 2) < 0.1);
    await video.evaluate(video => video.pause());
    await page.getByText('State history', { exact: true }).click();
    assert(await page.locator('.jobs details').evaluate(element => element.open));
    assert((await page.locator('.jobs details').innerText()).includes('completed'));
    await page.getByText('State history', { exact: true }).click();
    await mkdir(path.join(root, 'evidence'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'evidence', 'preview.png'), fullPage: true });
    return { sourceDurationSeconds: sourceDuration, outputDurationSeconds: duration, decodedPlayback: true };
  });
  await check('history survives reload and narrow viewport fits', async () => {
    await page.reload(); await page.locator('.jobs .completed').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(root, 'evidence', 'preview-mobile.png'), fullPage: true });
    return { viewportWidth: 390, overflow: false };
  });
  await check('no uncaught browser exceptions', async () => assert.deepEqual(pageErrors, []));
} catch (error) { failure = error; }
finally {
  const browserVersion = browser ? browser.version() : null;
  await browser?.close();
  if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
  const report = { recordedAt: new Date().toISOString(), command: 'npm run test:browser',
    browser: `Chromium ${browserVersion}`, elapsedMs: Math.round(performance.now() - started),
    passed: checks.filter(c => c.pass).length, failed: checks.filter(c => !c.pass).length,
    checks, pageErrors, serverStopped: server.exitCode !== null || server.signalCode !== null,
    dataDirectory: path.relative(root, dataDirectory),
    notTested: ['Screen readers', 'Safari', 'Firefox', 'Mobile hardware', 'Full accessibility audit'] };
  await mkdir(path.join(root, 'evidence'), { recursive: true });
  await writeFile(path.join(root, 'evidence', 'browser-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, serverStopped: report.serverStopped, report: 'evidence/browser-results.json' }));
}
if (failure) { console.error(failure.message); process.exitCode = 1; }
