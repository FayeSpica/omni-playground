import { useCallback, useEffect, useRef, useState } from 'react'
import { createVideo, deleteVideo, getVideo, listVideos, videoContentUrl } from '../lib/client'
import { fmtSeconds, useSettings } from '../lib/store'
import type { VideoJob } from '../lib/types'
import { Empty, ErrorBanner, Field, NumInput } from '../components/Field'
import { FileDrop, type PickedFile } from '../components/FileDrop'

const POLL_MS = 2500

export function VideoPage() {
  const settings = useSettings()
  const [prompt, setPrompt] = useState('')
  const [negative, setNegative] = useState('')
  const [reference, setReference] = useState<PickedFile[]>([])
  const [size, setSize] = useState('')
  const [seconds, setSeconds] = useState<number | ''>('')
  const [fps, setFps] = useState<number | ''>('')
  const [numFrames, setNumFrames] = useState<number | ''>('')
  const [steps, setSteps] = useState<number | ''>('')
  const [guidance, setGuidance] = useState<number | ''>('')
  const [seed, setSeed] = useState<number | ''>('')
  const [generateSound, setGenerateSound] = useState(false)
  const [imageRef, setImageRef] = useState('')
  const [videoRef, setVideoRef] = useState('')
  const [audioRef, setAudioRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<VideoJob[]>([])
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs

  const refreshList = useCallback(async () => {
    try {
      const res = await listVideos()
      setJobs((res.data ?? []).slice().sort((a, b) => b.created_at - a.created_at))
    } catch {
      /* server may not be up; job cards keep their last known state */
    }
  }, [])

  useEffect(() => {
    refreshList()
  }, [refreshList])

  // poll only while something is actually running
  useEffect(() => {
    const active = jobs.filter((j) => j.status === 'queued' || j.status === 'in_progress')
    if (active.length === 0) return
    const t = setInterval(async () => {
      const updates = await Promise.all(
        active.map((j) => getVideo(j.id).catch(() => null))
      )
      setJobs((cur) =>
        cur.map((j) => updates.find((u) => u && u.id === j.id) ?? j)
      )
    }, POLL_MS)
    return () => clearInterval(t)
  }, [jobs])

  async function submit() {
    if (!prompt.trim() || busy) return
    setBusy(true)
    setError(null)
    const form = new FormData()
    form.append('prompt', prompt.trim())
    if (settings.model) form.append('model', settings.model)
    if (reference[0]) form.append('input_reference', reference[0].file, reference[0].file.name)
    if (imageRef.trim()) form.append('image_reference', imageRef.trim())
    if (videoRef.trim()) form.append('video_reference', videoRef.trim())
    if (audioRef.trim()) form.append('audio_reference', audioRef.trim())
    if (size.trim()) form.append('size', size.trim())
    if (seconds !== '') form.append('seconds', String(seconds))
    if (fps !== '') form.append('fps', String(fps))
    if (numFrames !== '') form.append('num_frames', String(numFrames))
    if (steps !== '') form.append('num_inference_steps', String(steps))
    if (guidance !== '') form.append('guidance_scale', String(guidance))
    if (seed !== '') form.append('seed', String(seed))
    if (negative.trim()) form.append('negative_prompt', negative.trim())
    if (generateSound) form.append('generate_sound', 'true')
    try {
      const job = await createVideo(form)
      setJobs((cur) => [job, ...cur.filter((j) => j.id !== job.id)])
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    try {
      await deleteVideo(id)
    } catch {
      /* job may already be gone server-side; drop it locally either way */
    }
    setJobs((cur) => cur.filter((j) => j.id !== id))
  }

  const mode = reference.length > 0 || imageRef ? 'image → video' : videoRef ? 'video → video' : 'text → video'

  return (
    <div className="workbench">
      <div className="workbench__form">
        <Field label="prompt" hint={mode}>
          <textarea
            className="textarea"
            value={prompt}
            placeholder="A paper boat drifting down a rainy gutter stream, cinematic macro…"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>
        <Field label="reference (i2v)" hint="optional first-frame image">
          <FileDrop
            accept="image/*"
            files={reference}
            onChange={setReference}
            label="drop a reference image, or click to browse"
          />
        </Field>
        <div className="row--3 row">
          <Field label="size">
            <input
              className="input input--mono"
              value={size}
              placeholder="1280x720"
              onChange={(e) => setSize(e.target.value)}
            />
          </Field>
          <Field label="seconds">
            <NumInput value={seconds} min={1} placeholder="auto" onChange={setSeconds} />
          </Field>
          <Field label="fps">
            <NumInput value={fps} min={1} placeholder="auto" onChange={setFps} />
          </Field>
        </div>
        <details className="adv">
          <summary>advanced</summary>
          <div className="adv__body">
            <Field label="negative prompt">
              <textarea
                className="textarea"
                style={{ minHeight: 48 }}
                value={negative}
                onChange={(e) => setNegative(e.target.value)}
              />
            </Field>
            <div className="row--3 row">
              <Field label="frames">
                <NumInput value={numFrames} min={1} placeholder="auto" onChange={setNumFrames} />
              </Field>
              <Field label="steps">
                <NumInput value={steps} min={1} placeholder="default" onChange={setSteps} />
              </Field>
              <Field label="seed">
                <NumInput value={seed} placeholder="random" onChange={setSeed} />
              </Field>
            </div>
            <Field label="guidance scale">
              <NumInput value={guidance} step={0.1} placeholder="default" onChange={setGuidance} />
            </Field>
            <label
              style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text-dim)' }}
            >
              <input
                type="checkbox"
                checked={generateSound}
                onChange={(e) => setGenerateSound(e.target.checked)}
              />
              generate sound
            </label>
            <Field label="image reference" hint="server path / url">
              <input
                className="input input--mono"
                value={imageRef}
                onChange={(e) => setImageRef(e.target.value)}
              />
            </Field>
            <Field label="video reference" hint="server path / url">
              <input
                className="input input--mono"
                value={videoRef}
                onChange={(e) => setVideoRef(e.target.value)}
              />
            </Field>
            <Field label="audio reference" hint="server path / url">
              <input
                className="input input--mono"
                value={audioRef}
                onChange={(e) => setAudioRef(e.target.value)}
              />
            </Field>
          </div>
        </details>
        <ErrorBanner error={error} />
        <button className="btn btn--primary" onClick={submit} disabled={busy || !prompt.trim()}>
          {busy ? 'Submitting…' : 'Create video job'}
        </button>
        <button className="btn btn--ghost btn--sm" onClick={refreshList}>
          Refresh job list
        </button>
      </div>

      <div className="workbench__results">
        {jobs.length === 0 ? (
          <Empty title="no video jobs">
            Jobs render here with live progress — queued → in progress → completed, then play and
            download inline.
          </Empty>
        ) : (
          <div className="results-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>
            {jobs.map((j) => (
              <VideoCard key={j.id} job={j} onDelete={() => remove(j.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function VideoCard({ job, onDelete }: { job: VideoJob; onDelete: () => void }) {
  const running = job.status === 'queued' || job.status === 'in_progress'
  return (
    <div className="card">
      {job.status === 'completed' && (
        <div className="card__media">
          <video src={videoContentUrl(job.id)} controls loop />
        </div>
      )}
      <div className="card__body">
        <div className="card__row">
          <span className={`chip chip--${job.status}`}>{job.status.replace('_', ' ')}</span>
          <span className="meta">{job.id.slice(0, 18)}</span>
          <button className="btn btn--sm btn--ghost btn--danger" style={{ marginLeft: 'auto' }} onClick={onDelete}>
            Delete
          </button>
        </div>
        <div className="card__prompt" title={job.prompt}>
          {job.prompt}
        </div>
        {running && (
          <>
            <div className="progress">
              <div className="progress__bar" style={{ width: `${Math.max(job.progress, 3)}%` }} />
            </div>
            <span className="meta">{job.progress}%</span>
          </>
        )}
        {job.status === 'failed' && (
          <div className="error-banner">{job.error?.message ?? 'generation failed'}</div>
        )}
        <div className="card__row">
          <span className="meta">
            {job.size ? (
              <>
                <b>{job.size}</b> ·{' '}
              </>
            ) : null}
            {job.seconds ? `${job.seconds}s · ` : ''}
            {job.inference_time_s != null ? (
              <>
                infer <b>{fmtSeconds(job.inference_time_s)}</b>
              </>
            ) : null}
            {job.peak_memory_mb ? ` · peak ${(job.peak_memory_mb / 1024).toFixed(1)} GB` : ''}
          </span>
        </div>
        {job.status === 'completed' && (
          <div className="card__row">
            <a
              className="btn btn--sm btn--ghost"
              href={videoContentUrl(job.id)}
              download={`omni-${job.id}.mp4`}
            >
              Download
            </a>
            {job.stage_durations && Object.keys(job.stage_durations).length > 0 && (
              <span className="meta">
                {Object.entries(job.stage_durations)
                  .map(([k, v]) => `${k} ${fmtSeconds(v)}`)
                  .join(' · ')}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
