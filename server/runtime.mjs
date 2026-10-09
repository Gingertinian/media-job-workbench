import { execFileSync } from 'node:child_process';

export function binary(name) {
  const configured = process.env[name.toUpperCase() + '_PATH'];
  const candidates = configured ? [configured] : [name];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      execFileSync(candidate, ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      return candidate;
    } catch {}
  }
  throw new Error(`Missing ${name}. Set ${name.toUpperCase()}_PATH to an existing executable.`);
}
