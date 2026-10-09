import { spawn } from 'node:child_process';

let child;
process.on('disconnect', () => { child?.kill(); process.exit(1); });
process.on('message', ({ stop, ffmpeg, source, target, start, duration }) => {
  if (stop) { child?.kill(); return; }
  child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm',
    '-i', source, '-ss', String(start), '-t', String(duration),
    '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'fast', '-threads', '2', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-ar', '48000',
    '-movflags', '+faststart', target], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let detail = '';
  child.stderr.on('data', data => { detail = (detail + data.toString()).slice(-2000); });
  const timer = setTimeout(() => child.kill(), 120000);
  child.on('error', error => { clearTimeout(timer); process.send?.({ ok: false, detail: error.message }); });
  child.on('close', code => { clearTimeout(timer); process.send?.({ ok: code === 0, detail: code === 0 ? '' : detail || 'Export interrupted or timed out.' }); });
});
