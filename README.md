# Video export requests with safe retries

A React interface for importing a clip, selecting a time window and exporting a
playable MP4. Node records the jobs in SQLite and one local worker runs FFmpeg.

The example demonstrates a request whose response disappears after the server
accepted it. The client keeps the request key and original parameters until it
receives a matching acknowledgment. A retry returns the existing job. The
Restore pending export control recovers the saved form values after a reload
or accidental editing, so an unresolved request is not silently replaced.
By Jeronimo Munoz Larreta.

## Run

Requirements: Node 24+, npm, FFmpeg with libx264 and AAC encoders, and FFprobe. No database service, account, GPU, or provider credentials are needed. Dependencies install only into this directory. SQLite is built into Node.

From this directory in PowerShell:

```powershell
npm.cmd ci --no-audit --no-fund
npm.cmd run build
npm.cmd run sample
$env:DATA_DIR = Join-Path $env:TEMP ('media-export-' + [guid]::NewGuid().ToString('N'))
npm.cmd start
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). Import `samples/pendulum.mp4`, choose start `1` and duration `2`, then queue an export. Play or download the result. Ctrl+C stops the server and worker. Only loopback is bound.

FFmpeg and FFprobe must be on PATH, or configured explicitly:

```powershell
$env:FFMPEG_PATH = 'C:\tools\ffmpeg\bin\ffmpeg.exe'
$env:FFPROBE_PATH = 'C:\tools\ffmpeg\bin\ffprobe.exe'
```

Use your own executable paths. Missing tools fail at startup. `PORT` and
`DATA_DIR` optionally override the port and local storage directory.
Use a short absolute `DATA_DIR` on Windows because native SQLite may fail to
open deeply nested database paths. The folder and its contents are retained.

## Working and verified

- File-backed import and actual metadata inspection. Invalid media and invalid trim bounds are rejected. Inputs are limited to 32 MiB, 10 minutes, and 3840 x 2160; exports to 30 seconds.
- Durable `queued -> working -> completed/error` records and timestamped state history. One worker handles the queue sequentially.
- Real time-window export to H.264/AAC MP4, including source audio. A partial file is probed, then renamed before completion is recorded. Partial results are never served.
- Request idempotency: eight concurrent identical requests create one job. Reusing a key with different parameters returns HTTP 409. Keys and results survive server restart. The preview retains an unacknowledged request key in session storage for a matching retry.
- Recovery after a forcibly killed server while FFmpeg has opened an output: the working job runs again and queued work completes. The same job ID is kept and the attempt count increases. Processing can repeat; it is not exactly-once execution.
- A second server is refused for the same data directory. Completed files missing at startup become visible errors.
- Playable source and result, byte-range seeking, download, readable failure state, labeled native controls, visible keyboard focus, and a narrow-screen layout. A Chromium test uploads through the UI and verifies actual playback time advances.

The sample media is authored procedurally: a grayscale linked-pendulum motion study and a quiet synthesized 220 Hz tone. The motion is kinematic. No artist footage, stock media, or external generation is used. Source is `scripts/sample.mjs`; the resulting eight-second clip is included.

## Checks and measured evidence

```powershell
$env:TEST_DATA_ROOT = Join-Path $env:TEMP ('media-tests-' + [guid]::NewGuid().ToString('N'))
npm.cmd run build
npm.cmd test
npm.cmd run test:browser
npm.cmd run test:retry
```

The build checks TypeScript and bundles the preview. Integration tests start actual servers in fresh local data directories, invoke real FFmpeg, probe/decode outputs, compare a decoded frame against the requested source time, force a process restart, and check persisted jobs. All test servers are stopped on completion. Test data is retained under `evidence/test-data/` and `evidence/browser-data/` for inspection.

Browser checks need Playwright with Chromium installed. Install it separately
or set `PLAYWRIGHT_MODULE` to an existing `index.mjs`. It is optional for the app
and backend tests.

The retry suite requires Node 24, full `FFMPEG_PATH` and `FFPROBE_PATH` paths,
and an installed Chromium with the Playwright module available. `PLAYWRIGHT_MODULE`
may point to an existing `index.mjs`; no browser dependency is required by the app.
If Playwright is unavailable, the retry report explicitly marks its UI checks
as skipped. `TEST_DATA_ROOT` controls the short isolated data directories.

The retry test forwards a real successful POST through a loopback proxy, consumes
the response, then drops the client connection. It checks same-key recovery,
fresh-key duplication, conflicting parameters, concurrency, restart replay and
actual MP4 decoding. UI checks cover reload recovery, changed form values,
storage-write/removal failure and a mismatched acknowledgment. All owned test
servers, proxy sockets and headless browser processes are stopped afterward.

The test commands write detailed local reports under `evidence/`. Retry reports
and their captures are stored in ignored `evidence/retry-contract-*` directories.
`CHECKS.txt`
summarizes the verified run. `evidence/preview.png` and `preview-mobile.png` are
actual screenshots after an export. `evidence/retry-recovery.png` shows the
retained request and recovery control while changed form values are blocked.

## API

| Request | Behavior |
| --- | --- |
| `POST /api/assets` | Raw video body; optional ASCII `X-File-Name` header; returns asset metadata. |
| `GET /api/assets` | Imported sources with playback URLs. |
| `POST /api/jobs` | JSON `{ "assetId": "...", "start": 1, "duration": 2 }` and `Idempotency-Key` header; returns 202 for a new job, 200 for a replay. |
| `GET /api/jobs` or `/api/jobs/:id` | Current state, attempts, error, and full state history. |
| `GET /api/jobs/:id/result` | Completed MP4 with byte ranges; `?download` sets attachment disposition. |
| `GET /api/health` | Local mode and worker availability. |

To retry a failed job, submit a new request key. Reusing its old key returns the recorded failure. Polling runs once a second in the preview.

## Limits and not tested

No generation-provider adapter, distributed scheduling, authentication, cancellation UI, retention policy, or production deployment. Files and SQLite stay on this computer. Interrupted attempt files can remain in `partial/`; they are never exposed as results. A missing source is reported when its job runs. No cleanup task or background service is installed.

Power loss, disk failure, PID reuse, hostile-media fuzzing, uploaded formats beyond the authored MP4, uploads near the 32 MiB boundary, screen readers, Safari/Firefox, and mobile hardware were not tested. Container/protocol restrictions, same-origin writes, and loopback binding are basic local boundaries, not a media sandbox. A sandbox and resource isolation would be necessary before accepting untrusted public uploads.
