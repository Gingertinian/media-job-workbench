import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { binary } from '../server/runtime.mjs';

const output = path.resolve(process.argv[2] || fileURLToPath(new URL('../samples/pendulum.mp4', import.meta.url)));
mkdirSync(path.dirname(output), { recursive: true });
const width = 640, height = 360, fps = 24, seconds = 8;
const ffmpeg = spawn(binary('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0',
  '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', String(seconds),
  '-c:v', 'libx264', '-preset', 'fast', '-threads', '2', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-af', 'volume=0.08', '-movflags', '+faststart', output], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
let error = '';
ffmpeg.stderr.on('data', chunk => error += chunk);
const done = once(ffmpeg, 'close');
function pixel(frame, x, y, shade) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const i = (y * width + x) * 3; frame[i] = frame[i + 1] = frame[i + 2] = shade;
}
function line(frame, x1, y1, x2, y2, shade, thick = 1) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1));
  for (let s = 0; s <= steps; s++) for (let d = 0; d < thick; d++)
    pixel(frame, x1 + (x2 - x1) * s / steps + d, y1 + (y2 - y1) * s / steps, shade);
}
function circle(frame, x, y, radius, shade) {
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++)
    if (dx * dx + dy * dy <= radius * radius) pixel(frame, x + dx, y + dy, shade);
}
const trail = [];
for (let f = 0; f < fps * seconds; f++) {
  const frame = Buffer.alloc(width * height * 3, 237), t = f / fps;
  const a = 0.9 * Math.cos(t * 2.2), b = 1.1 * Math.sin(t * 2.6 + 0.4);
  const x1 = 320 + 92 * Math.sin(a), y1 = 70 + 92 * Math.cos(a);
  const x2 = x1 + 85 * Math.sin(b), y2 = y1 + 85 * Math.cos(b);
  trail.push([x2, y2]); if (trail.length > 48) trail.shift();
  for (let i = 1; i < trail.length; i++) line(frame, ...trail[i - 1], ...trail[i], 200 - i);
  line(frame, 265, 69, 375, 69, 65, 2); line(frame, 320, 70, x1, y1, 65, 2);
  line(frame, x1, y1, x2, y2, 65, 2); circle(frame, 320, 70, 5, 30);
  circle(frame, x1, y1, 9, 65); circle(frame, x2, y2, 13, 30);
  line(frame, 240, 320, 400, 320, 170);
  for (let tick = 0; tick <= 8; tick++) line(frame, 240 + tick * 20, 315, 240 + tick * 20, 325, 150);
  circle(frame, 240 + f / (fps * seconds - 1) * 160, 320, 3, 30);
  if (!ffmpeg.stdin.write(frame)) await once(ffmpeg.stdin, 'drain');
}
ffmpeg.stdin.end();
const [code] = await done;
if (code !== 0) throw new Error(error);
console.log(JSON.stringify({ file: output, duration: seconds, width, height, fps, audio: 'authored 220 Hz quiet sine', frames: fps * seconds }));
