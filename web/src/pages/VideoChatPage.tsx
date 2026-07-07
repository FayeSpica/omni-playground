import { useRef, useState } from 'react'
import { mergeWavSegments } from '../lib/audio'
import {
  generateVideoStream,
  sampleVideoFrames,
  videoChatStream,
} from '../lib/streams'
import { useSettings } from '../lib/store'
import { Empty, ErrorBanner, Field } from '../components/Field'
import { FileDrop, type PickedFile } from '../components/FileDrop'
import { Markdown } from '../components/Markdown'

type Mode = 'chat' | 'generate'

export function VideoChatPage() {
  const [mode, setMode] = useState<Mode>('chat')
  return (
    <div className="chat">
      <div className="chat__main" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '14px 20px 0' }}>
          <button className={`btn${mode === 'chat' ? ' btn--primary' : ''}`} onClick={() => setMode('chat')}>
            Chat · /v1/video/chat/stream
          </button>
          <button
            className={`btn${mode === 'generate' ? ' btn--primary' : ''}`}
            onClick={() => setMode('generate')}
          >
            Generate · /v1/realtime/video
          </button>
        </div>
        {mode === 'chat' ? <VideoChat /> : <VideoGenerate />}
      </div>
    </div>
  )
}

// —— video-in → text/audio (/v1/video/chat/stream) ——

const FRAME_COUNT = 8

function VideoChat() {
  const settings = useSettings()
  const [video, setVideo] = useState<PickedFile[]>([])
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const closeRef = useRef<(() => void) | null>(null)

  async function run() {
    if (!video[0] || busy) return
    setBusy(true)
    setError(null)
    setText('')
    setAudioUrl(null)
    setStatus('sampling frames…')
    let frames: string[]
    try {
      frames = await sampleVideoFrames(video[0].file, FRAME_COUNT)
    } catch (e) {
      setError(String((e as Error).message ?? e))
      setBusy(false)
      return
    }
    setStatus(`streaming ${frames.length} frames…`)
    const segs: string[] = []
    closeRef.current = videoChatStream(
      {
        frames,
        text: prompt.trim() || 'Describe what happens in this video.',
        model: settings.model || undefined,
      },
      {
        onText: (d) => setText((t) => t + d),
        onAudio: (b64) => {
          segs.push(b64)
          const blob = mergeWavSegments(segs)
          if (blob) setAudioUrl((prev) => (prev && URL.revokeObjectURL(prev), URL.createObjectURL(blob)))
        },
        onDone: () => {
          setBusy(false)
          setStatus('')
        },
        onError: (msg) => {
          setError(msg)
          setBusy(false)
          setStatus('')
        },
      }
    )
  }

  function stop() {
    closeRef.current?.()
    setBusy(false)
    setStatus('')
  }

  return (
    <div className="workbench" style={{ borderTop: 'none' }}>
      <div className="workbench__form">
        <Field label="video">
          <FileDrop
            accept="video/*"
            files={video}
            onChange={setVideo}
            label="drop a video clip, or click to browse"
          />
        </Field>
        <Field label="prompt" hint={`${FRAME_COUNT} frames sampled & sent`}>
          <textarea
            className="textarea"
            value={prompt}
            placeholder="Describe what happens in this video, then summarize the mood."
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>
        <ErrorBanner error={error} />
        {busy ? (
          <button className="btn btn--danger" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="btn btn--primary" onClick={run} disabled={!video[0]}>
            Send clip
          </button>
        )}
        {busy && (
          <>
            <div className="progress">
              <div className="progress__bar" style={{ width: '100%' }} />
            </div>
            {status && <span className="meta">{status}</span>}
          </>
        )}
      </div>
      <div className="workbench__results">
        {!text && !audioUrl && !busy ? (
          <Empty title="no reply yet">
            Frames are sampled from the clip in-browser and streamed to the omni model, which replies
            with text and (for audio-capable models) speech.
          </Empty>
        ) : (
          <div className="card" style={{ maxWidth: 720 }}>
            <div className="card__body">
              {audioUrl && (
                <div className="msg__audio" style={{ marginBottom: 10 }}>
                  <span className="chip chip--completed">audio</span>
                  <audio src={audioUrl} controls />
                  <a className="btn btn--sm btn--ghost" href={audioUrl} download="omni-videochat.wav">
                    ↓
                  </a>
                </div>
              )}
              <Markdown text={text || (busy ? '…' : '')} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// —— prompt → generated video, streamed as fMP4 chunks (/v1/realtime/video) ——

function VideoGenerate() {
  const settings = useSettings()
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [bytes, setBytes] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const closeRef = useRef<(() => void) | null>(null)

  function run() {
    if (!prompt.trim() || busy) return
    setBusy(true)
    setError(null)
    setBytes(0)
    setVideoUrl(null)
    const chunks: Uint8Array[] = []
    closeRef.current = generateVideoStream(
      { prompt: prompt.trim(), model: settings.model || undefined },
      {
        onChunk: (b) => {
          chunks.push(b)
          setBytes((n) => n + b.length)
        },
        onDone: () => {
          if (chunks.length) {
            const blob = new Blob(chunks as BlobPart[], { type: 'video/mp4' })
            setVideoUrl(URL.createObjectURL(blob))
          }
          setBusy(false)
        },
        onError: (msg) => {
          setError(msg)
          setBusy(false)
        },
      }
    )
  }

  function stop() {
    closeRef.current?.()
    setBusy(false)
  }

  return (
    <div className="workbench" style={{ borderTop: 'none' }}>
      <div className="workbench__form">
        <Field label="prompt">
          <textarea
            className="textarea"
            value={prompt}
            placeholder="A paper boat drifting down a rainy gutter stream, cinematic macro…"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>
        <ErrorBanner error={error} />
        {busy ? (
          <button className="btn btn--danger" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="btn btn--primary" onClick={run} disabled={!prompt.trim()}>
            Generate video
          </button>
        )}
        {busy && (
          <>
            <div className="progress">
              <div className="progress__bar" style={{ width: '100%' }} />
            </div>
            <span className="meta">received {(bytes / 1024).toFixed(0)} KB…</span>
          </>
        )}
        <div className="drawer__note">
          Streams fragmented-MP4 chunks over <code>/v1/realtime/video</code> as the model generates
          them, then plays the assembled clip. Needs a video-generation model loaded on the target.
        </div>
      </div>
      <div className="workbench__results">
        {!videoUrl && !busy ? (
          <Empty title="no video yet">The generated clip appears here once streaming completes.</Empty>
        ) : (
          <div className="card" style={{ maxWidth: 720 }}>
            {videoUrl && (
              <div className="card__media">
                <video src={videoUrl} controls loop />
              </div>
            )}
            <div className="card__body">
              <div className="card__row">
                <span className={`chip ${busy ? 'chip--in_progress' : 'chip--completed'}`}>
                  {busy ? 'streaming' : 'done'}
                </span>
                {videoUrl && (
                  <a className="btn btn--sm btn--ghost" href={videoUrl} download="omni-generated.mp4">
                    Download
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
