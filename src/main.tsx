import { StrictMode, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Asset = { id: string; name: string; duration: number; width: number; height: number; sourceUrl: string };
type Job = { id: string; assetId: string; start: number; duration: number; status: 'queued' | 'working' | 'completed' | 'error'; attempts: number; error: string | null; resultUrl: string | null; events: { status: string; at: string; reason: string | null }[] };
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
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const source = assets.find(a => a.id === assetId);
  useEffect(() => {
    try { pending.current = JSON.parse(sessionStorage.getItem('pending-export') || 'null'); } catch { /* Empty draft. */ }
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
    event.preventDefault(); setBusy(true); setError('');
    const body = { assetId, start, duration }, signature = JSON.stringify(body);
    if (pending.current?.signature !== signature) pending.current = { signature, key: crypto.randomUUID() };
    sessionStorage.setItem('pending-export', JSON.stringify(pending.current));
    try {
      const job = await api<Job>('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.current!.key }, body: signature });
      setJobs(old => [job, ...old.filter(j => j.id !== job.id)]); setMessage('Export accepted.');
      pending.current = null; sessionStorage.removeItem('pending-export');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
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
        <div className="fields"><label>Start (seconds)<input type="number" min="0" max={source ? Math.max(0, source.duration - duration) : 0} step="0.01" value={start} onChange={e => setStart(e.target.valueAsNumber)} required /></label>
          <label>Duration (seconds)<input type="number" min="0.1" max={source ? Math.min(30, source.duration - start) : 30} step="0.01" value={duration} onChange={e => setDuration(e.target.valueAsNumber)} required /></label></div>
        <button disabled={!source || busy} type="submit">{busy ? 'Please wait...' : 'Queue MP4 export'}</button>
      </form>
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
