import { StrictMode, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Asset = { id: string; name: string; duration: number; width: number; height: number; sourceUrl: string };
type Job = { id: string; assetId: string; start: number; duration: number; status: 'queued' | 'working' | 'completed' | 'error'; attempts: number; error: string | null; resultUrl: string | null; events: { status: string; at: string; reason: string | null }[] };
type ExportRequest = { assetId: string; start: number; duration: number };
type PendingExport = { signature: string; key: string };
const states = ['queued', 'working', 'completed', 'error'];
function savedRequest(value: unknown): PendingExport | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<PendingExport>;
  if (typeof entry.key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(entry.key) || typeof entry.signature !== 'string') return null;
  try {
    const body = JSON.parse(entry.signature) as ExportRequest;
    if (!body || typeof body.assetId !== 'string' || !Number.isFinite(body.start) || body.start < 0 || !Number.isFinite(body.duration) || body.duration < 0.1 || body.duration > 30) return null;
    return { signature: entry.signature, key: entry.key };
  } catch { return null; }
}
function acknowledgedJob(value: unknown, body: ExportRequest): value is Job {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<Job>;
  return typeof job.id === 'string' && /^[a-f0-9-]{36}$/.test(job.id) && job.assetId === body.assetId && job.start === body.start && job.duration === body.duration
    && typeof job.status === 'string' && states.includes(job.status) && Number.isInteger(job.attempts) && Number(job.attempts) >= 0
    && (job.error === null || typeof job.error === 'string') && (job.resultUrl === null || job.resultUrl === `/api/jobs/${job.id}/result`)
    && Array.isArray(job.events) && job.events.every(event => event && states.includes(event.status) && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)) && (event.reason === null || typeof event.reason === 'string'));
}
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function App() {
  const [assets, setAssets] = useState<Asset[]>([]), [jobs, setJobs] = useState<Job[]>([]);
  const [assetId, setAssetId] = useState(''), [start, setStart] = useState(0), [duration, setDuration] = useState(2);
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const pending = useRef<PendingExport | null>(null);
  const [savedExport, setSavedExport] = useState<PendingExport | null>(null);
  const source = assets.find(a => a.id === assetId);
  useEffect(() => {
    try { pending.current = savedRequest(JSON.parse(sessionStorage.getItem('pending-export') || 'null')); setSavedExport(pending.current); } catch { /* No readable saved request. */ }
    let mounted = true;
    async function refresh() {
      try {
        const [a, j] = await Promise.all([api<Asset[]>('/api/assets'), api<Job[]>('/api/jobs')]);
        if (mounted) { setAssets(a); setJobs(j); }
      } catch (e) { if (mounted) setError((e as Error).message); }
    }
    refresh(); const timer = window.setInterval(refresh, 1000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  async function upload(file?: File) {
    if (!file) return;
    setBusy(true); setError(''); setMessage('Reading video...');
    try {
      const asset = await api<Asset>('/api/assets', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': file.name.replace(/[^\x20-\x7e]/g, '_') }, body: file });
      setAssets(old => [asset, ...old]); setAssetId(asset.id); setStart(0); setDuration(Math.min(2, asset.duration));
      setMessage(`Imported ${asset.name}.`);
    } catch (e) { setError((e as Error).message); setMessage(''); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const body = { assetId, start, duration }, signature = JSON.stringify(body);
      if (pending.current && pending.current.signature !== signature) throw new Error('A saved export still needs acknowledgment. Restore and retry it before starting another export.');
      if (!pending.current) pending.current = { signature, key: crypto.randomUUID() };
      setSavedExport(pending.current);
      try { sessionStorage.setItem('pending-export', JSON.stringify(pending.current)); }
      catch { throw new Error('Could not save retry details, so no export request was sent. Session storage must be available to continue safely.'); }
      const job = await api<unknown>('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.current.key }, body: signature });
      if (!acknowledgedJob(job, body)) throw new Error('The server response did not acknowledge this export. Its request key has been kept for a safe retry.');
      setJobs(old => [job, ...old.filter(j => j.id !== job.id)]); setMessage('Export accepted.');
      try { sessionStorage.removeItem('pending-export'); }
      catch { setMessage('Export accepted. Saved retry details could not be cleared; retrying will recover this same export.'); return; }
      pending.current = null; setSavedExport(null);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function restorePending() {
    if (!pending.current) return;
    const body = JSON.parse(pending.current.signature) as ExportRequest;
    setAssetId(body.assetId); setStart(body.start); setDuration(body.duration); setError('');
    setMessage('Saved export restored. Queue it again to recover the same job.');
  }
  return <main>
    <header><h1>Media export</h1><p>Local demo · Jeronimo Munoz Larreta · 9 October 2026</p></header>
    <p className="intro">Import a video, choose a time window, export an MP4. Files and job history stay on this computer.</p>
    <section aria-labelledby="input-heading"><h2 id="input-heading">Source and export</h2>
      <label className="upload">Import video <input type="file" accept="video/mp4,video/quicktime,video/webm" disabled={busy} onChange={e => { upload(e.target.files?.[0]); e.target.value = ''; }} /></label>
      <p className="hint">MP4, MOV or WebM · up to 32 MiB, 10 minutes, 3840 × 2160</p>
      <form onSubmit={submit}>
        <label>Source <select value={assetId} onChange={e => { setAssetId(e.target.value); setStart(0); const a = assets.find(a => a.id === e.target.value); setDuration(Math.min(2, a?.duration || 2)); }} required disabled={busy}>
          <option value="">Choose an imported video</option>{assets.map(a => <option key={a.id} value={a.id}>{a.name} ({a.duration.toFixed(2)}s)</option>)}</select></label>
        {source && <><video key={source.id} src={source.sourceUrl} controls preload="metadata" aria-label="Source video preview" /><p className="hint">{source.width} × {source.height} · {source.duration.toFixed(2)} seconds</p></>}
        <div className="fields"><label>Start (seconds)<input type="number" min="0" max={source ? Math.max(0, source.duration - duration) : 0} step="0.01" value={start} onChange={e => setStart(e.target.valueAsNumber)} required disabled={busy} /></label>
          <label>Duration (seconds)<input type="number" min="0.1" max={source ? Math.min(30, source.duration - start) : 30} step="0.01" value={duration} onChange={e => setDuration(e.target.valueAsNumber)} required disabled={busy} /></label></div>
        <button disabled={!source || busy} type="submit">{busy ? 'Please wait...' : 'Queue MP4 export'}</button>
      </form>
      {savedExport && <div><p className="hint">A saved export request is retained until its matching acknowledgment is received. Changing form values will not replace it.</p><button type="button" disabled={busy} onClick={restorePending}>Restore pending export</button></div>}
      <p role="status" aria-live="polite">{message} {jobs.length ? `${jobs.filter(j => j.status === 'completed').length} completed, ${jobs.filter(j => j.status === 'working' || j.status === 'queued').length} pending, ${jobs.filter(j => j.status === 'error').length} failed.` : ''}</p>{error && <p role="alert" className="error">{error}</p>}
    </section>
    <section aria-labelledby="jobs-heading"><h2 id="jobs-heading">Job history</h2><p className="hint">Queued → working → completed or error. Interrupted work is queued again when the server restarts.</p>
      {!jobs.length && <p>No exports yet.</p>}
      <ol className="jobs">{jobs.map(job => <li key={job.id}>
        <div className="job-title"><strong>{assets.find(a => a.id === job.assetId)?.name || 'Video'}</strong><span className={`status ${job.status}`}>{job.status}</span></div>
        <p className="hint">{job.start.toFixed(2)}s to {(job.start + job.duration).toFixed(2)}s · Attempt {job.attempts} · <code>{job.id.slice(0, 8)}</code></p>
        {job.error && <p className="error">{job.error}</p>}
        {job.resultUrl && <><video src={job.resultUrl} controls preload="metadata" aria-label={`Export preview ${job.id.slice(0, 8)}`} /><a href={`${job.resultUrl}?download`}>Download MP4</a></>}
        <details><summary>State history</summary><ul>{job.events.map((e, i) => <li key={i}><time dateTime={e.at}>{new Date(e.at).toLocaleTimeString()}</time> · {e.status}{e.reason ? ` · ${e.reason}` : ''}</li>)}</ul></details>
      </li>)}</ol>
    </section>
    <footer>One local worker and SQLite. This sample does not implement distributed scheduling or generation providers.</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
