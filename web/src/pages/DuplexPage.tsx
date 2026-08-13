import { useEffect, useRef, useState } from 'react'
import {
  DuplexSession,
  INPUT_RATE,
  MicCapture,
  PcmPlayer,
  decodeToPcm16,
  pcm16ChunksToWav,
  pcm16ToBase64,
  realtimeUrl,
} from '../lib/realtime'
import { fsList, fsRead, type FsEntry } from '../lib/client'
import {
  hasDirPermission,
  listNativeAudio,
  loadDirectory,
  pickDirectory,
  readNativeFile,
  requestDirPermission,
  supportsNativeDir,
} from '../lib/fsdir'
import { fileToDataURL, getSettings, useSettings } from '../lib/store'
import { Empty, ErrorBanner, Field } from '../components/Field'
import { DirPicker } from '../components/DirPicker'
import { FileDrop, type PickedFile } from '../components/FileDrop'

interface Turn {
  role: 'user' | 'assistant'
  text: string
  audioUrl?: string // assistant reply, merged WAV
}

type Phase = 'idle' | 'connecting' | 'ready'

export function DuplexPage() {
  const settings = useSettings()
  const [phase, setPhase] = useState<Phase>('idle')
  const [muted, setMuted] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [events, setEvents] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const [instructions, setInstructions] = useState('')
  const [refAudio, setRefAudio] = useState<PickedFile[]>([])
  const [clipDir, setClipDir] = useState(
    () => localStorage.getItem('omni-playground:record-dir') || '/tmp/omni-recordings'
  )
  const [clipFiles, setClipFiles] = useState<FsEntry[]>([])
  const [clipName, setClipName] = useState<string | null>(null)
  const [clipPlaying, setClipPlaying] = useState(false)
  const [clipHandle, setClipHandle] = useState<FileSystemDirectoryHandle | null>(null)

  const sessionRef = useRef<DuplexSession | null>(null)
  const micRef = useRef<MicCapture | null>(null)
  const playerRef = useRef<PcmPlayer | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const turnAudioRef = useRef<{ chunks: string[]; rate: number }>({ chunks: [], rate: 24000 })
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  const clipRef = useRef<Int16Array | null>(null)
  const clipPlayingRef = useRef(false)
  const clipTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [events])

  function logEvent(type: string) {
    const time = new Date().toLocaleTimeString([], { hour12: false })
    setEvents((cur) => [...cur.slice(-79), `${time}  ${type}`])
  }

  function appendText(role: 'user' | 'assistant', delta: string) {
    setTurns((cur) => {
      const next = [...cur]
      const last = next[next.length - 1]
      if (last?.role === role) next[next.length - 1] = { ...last, text: last.text + delta }
      else next.push({ role, text: delta })
      return next
    })
  }

  async function start() {
    if (!settings.model) {
      setError('Select a model first (top-right) — the duplex endpoint needs one.')
      return
    }
    if (!refAudio.length) {
      setError('Pick a reference audio clip first — MiniCPM-o native duplex requires ref_audio for voice output.')
      return
    }
    setError(null)
    setPhase('connecting')
    const player = new PcmPlayer()
    playerRef.current = player
    const session = new DuplexSession(
      realtimeUrl('/v1/realtime', {
        duplex: '1',
        model: settings.model,
        minicpmo45_native_duplex: '1',
        autostart: '0',
        api_key: getSettings().apiKey || undefined,
      }),
      {
        model: settings.model,
        instructions: instructions.trim() || undefined,
        refAudio: await fileToDataURL(refAudio[0].file),
      },
      {
        onReady: () => setPhase('ready'),
        onEvent: logEvent,
        onSpeakingChange: setSpeaking,
        onUserText: (delta) => appendText('user', delta),
        onAssistantText: (delta) => appendText('assistant', delta),
        onAudio: (b64, rate) => {
          const buf = turnAudioRef.current
          buf.chunks.push(b64)
          buf.rate = rate
          player.enqueue(b64, rate) // gapless live playback
          // grow the reply's WAV so the audio bar shows from the first chunk
          const blob = pcm16ChunksToWav(buf.chunks, rate)
          if (!blob) return
          const url = URL.createObjectURL(blob)
          setTurns((cur) => {
            const next = [...cur]
            const last = next[next.length - 1]
            if (last?.role === 'assistant') {
              if (last.audioUrl) URL.revokeObjectURL(last.audioUrl)
              next[next.length - 1] = { ...last, audioUrl: url }
            } else {
              next.push({ role: 'assistant', text: '', audioUrl: url })
            }
            return next
          })
        },
        onAudioDone: (responseId, totalMs) => {
          // ack after the queued audio has actually played (ack_only commit)
          if (!responseId || totalMs <= 0) return
          const wait = playerRef.current?.bufferedMs() ?? 0
          setTimeout(() => sessionRef.current?.sendPlaybackAck(responseId, totalMs), wait)
        },
        onPlaybackCleared: () => {
          // server truncated output (barge-in) — cut local playback short too
          playerRef.current?.interrupt()
          turnAudioRef.current = { chunks: [], rate: 24000 }
        },
        onError: (msg) => setError(msg),
        onClose: () => setPhase('idle'),
      }
    )
    sessionRef.current = session
    session.connect()

    const mic = new MicCapture()
    micRef.current = mic
    try {
      await mic.start(
        (b64) => {
          // while a clip is playing back it owns the input channel
          if (!mutedRef.current && !clipPlayingRef.current) session.appendAudio(b64)
        },
        (lvl) => setLevel(lvl)
      )
    } catch (e) {
      setError(`microphone: ${(e as Error).message ?? e}`)
      mic.stop()
      micRef.current = null
    }
  }

  // —— simulate input: replay a recorded clip into the session ——

  function stopClip() {
    if (clipTimerRef.current) clearInterval(clipTimerRef.current)
    clipTimerRef.current = null
    clipPlayingRef.current = false
    setClipPlaying(false)
  }

  async function refreshClips(handle = clipHandle) {
    try {
      setClipFiles(handle ? await listNativeAudio(handle) : await fsList(clipDir.trim()))
    } catch {
      setClipFiles([])
    }
  }

  async function chooseClipDirectory() {
    const handle = await pickDirectory()
    if (!handle) return
    if (!(await requestDirPermission(handle))) {
      setError('directory access was not granted')
      return
    }
    setClipHandle(handle)
    setClipName(null)
    clipRef.current = null
    refreshClips(handle)
  }

  async function loadClip(entry: FsEntry) {
    stopClip()
    setError(null)
    try {
      const blob = clipHandle
        ? await readNativeFile(clipHandle, entry.name)
        : await fsRead(`${clipDir.trim().replace(/\/$/, '')}/${entry.name}`)
      clipRef.current = await decodeToPcm16(await blob.arrayBuffer())
      setClipName(entry.name)
    } catch (e) {
      setError(`load clip: ${(e as Error).message ?? e}`)
    }
  }

  function playClip() {
    const pcm = clipRef.current
    const session = sessionRef.current
    if (!pcm || !session?.ready || clipPlayingRef.current) return
    clipPlayingRef.current = true
    setClipPlaying(true)
    const CHUNK = INPUT_RATE / 5 // 200 ms of PCM16 @ 16 kHz per tick, realtime pace
    let off = 0
    clipTimerRef.current = setInterval(() => {
      if (off >= pcm.length) {
        stopClip()
        return
      }
      session.appendAudio(pcm16ToBase64(pcm.subarray(off, off + CHUNK)))
      off += CHUNK
    }, 200)
  }

  function stop() {
    stopClip()
    micRef.current?.stop()
    playerRef.current?.close()
    sessionRef.current?.close()
    micRef.current = null
    playerRef.current = null
    sessionRef.current = null
    turnAudioRef.current = { chunks: [], rate: 24000 }
    setPhase('idle')
    setMuted(false)
    setSpeaking(false)
    setLevel(0)
  }

  // Tear everything down if the page unmounts mid-call.
  useEffect(() => () => stop(), [])

  // Load the clip listing once on mount — native directory when available and
  // already permitted, otherwise the server-side directory.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!supportsNativeDir) {
      void refreshClips()
      return
    }
    loadDirectory().then(async (handle) => {
      if (handle && (await hasDirPermission(handle))) {
        setClipHandle(handle)
        refreshClips(handle)
      } else {
        refreshClips()
      }
    })
  }, [])

  const ready = phase === 'ready'
  const statusLabel =
    phase === 'connecting'
      ? 'connecting…'
      : !ready
        ? 'idle'
        : clipPlaying
          ? '▶ playing clip'
          : speaking
            ? '▶ model speaking'
            : muted
              ? '● listening (mic muted)'
              : '● listening'

  return (
    <div className="chat">
      <div className="chat__main">
        <div className="chat__scroll" ref={scrollRef}>
          {turns.length === 0 ? (
            <Empty
              title={ready ? 'session live — just talk' : 'not connected'}
            >
              {ready
                ? 'The mic streams continuously; the model itself decides when to answer and when to keep listening. Talk over it to barge in.'
                : 'Full-duplex voice over /v1/realtime?duplex=1 (native MiniCPM-o duplex). Pick a reference voice on the right, start a session, and talk — no push-to-talk, no client VAD.'}
            </Empty>
          ) : (
            turns.map((t, i) => (
              <div key={i} className={`msg msg--${t.role}`}>
                <div className="msg__who">{t.role === 'user' ? 'you' : settings.model || 'model'}</div>
                <div className="msg__bubble">
                  {t.text && <span style={{ whiteSpace: 'pre-wrap' }}>{t.text}</span>}
                  {t.audioUrl && (
                    <div className="msg__audio">
                      <span className="chip chip--completed">audio</span>
                      <audio src={t.audioUrl} controls />
                      <a
                        className="btn btn--sm btn--ghost"
                        href={t.audioUrl}
                        download={`omni-duplex-${i}.wav`}
                      >
                        ↓
                      </a>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
        <div className="chat__composer">
          <ErrorBanner error={error} />
          <div className="chat__inputrow" style={{ alignItems: 'center', gap: 14 }}>
            <div className="rt-meter" title="mic level">
              <div
                className="rt-meter__fill"
                style={{ width: ready && !muted ? `${Math.round(level * 100)}%` : '0%' }}
              />
            </div>
            <span className="meta" style={{ minWidth: 150 }}>
              {statusLabel}
            </span>
            {!ready ? (
              <button className="btn btn--primary" onClick={start} disabled={phase === 'connecting'}>
                {phase === 'connecting' ? 'Connecting…' : 'Start session'}
              </button>
            ) : (
              <>
                <button
                  className={`btn${muted ? ' btn--primary' : ''}`}
                  onClick={() => setMuted((m) => !m)}
                >
                  {muted ? 'Unmute' : 'Mute'}
                </button>
                <button className="btn btn--danger" onClick={stop}>
                  End session
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <aside className="chat__aside">
        <div className="section-title">reference voice</div>
        <FileDrop
          accept="audio/*"
          files={refAudio}
          onChange={setRefAudio}
          label="Drop a ref audio clip (voice clone)"
        />
        <Field label="instructions" hint="optional system prompt">
          <textarea
            className="textarea"
            rows={3}
            value={instructions}
            placeholder="e.g. 你处于双工模式，可以一边听、一边说。"
            onChange={(e) => setInstructions(e.target.value)}
            disabled={ready}
          />
        </Field>
        <div className="section-title">simulate input</div>
        {supportsNativeDir ? (
          <>
            <div className="row" style={{ alignItems: 'center' }}>
              <button className="btn btn--primary btn--sm" onClick={chooseClipDirectory}>
                Choose directory…
              </button>
              <span className="meta input--mono" style={{ fontSize: 12 }}>
                {clipHandle ? clipHandle.name : 'no directory chosen'}
              </span>
            </div>
            {!clipHandle && (
              <div className="drawer__note">
                Pick the same folder you record into on the Record page.
              </div>
            )}
          </>
        ) : (
          <>
            <Field label="clip directory" hint="from the Record page">
              <input
                className="input input--mono"
                value={clipDir}
                placeholder="/tmp/omni-recordings"
                onChange={(e) => {
                  setClipDir(e.target.value)
                  localStorage.setItem('omni-playground:record-dir', e.target.value)
                }}
                onBlur={() => refreshClips()}
              />
            </Field>
            <DirPicker
              value={clipDir}
              onSelect={(d) => {
                setClipDir(d)
                localStorage.setItem('omni-playground:record-dir', d)
                fsList(d)
                  .then(setClipFiles)
                  .catch(() => setClipFiles([]))
              }}
            />
          </>
        )}
        <div className="row">
          <button className="btn btn--ghost btn--sm" onClick={() => refreshClips()}>
            Refresh
          </button>
        </div>
        {clipFiles.length > 0 && (
          <div style={{ maxHeight: 120, overflowY: 'auto' }}>
            {clipFiles.map((f) => (
              <div key={f.name} className="row" style={{ justifyContent: 'space-between' }}>
                <span className="meta input--mono" style={{ fontSize: 12 }}>
                  {f.name}
                </span>
                <button
                  className={`btn btn--sm${clipName === f.name ? ' btn--primary' : ' btn--ghost'}`}
                  onClick={() => loadClip(f)}
                >
                  {clipName === f.name ? 'loaded' : 'load'}
                </button>
              </div>
            ))}
          </div>
        )}
        {clipName && (
          <div className="row" style={{ alignItems: 'center' }}>
            <span className="meta" style={{ flex: 1 }}>
              {clipName}
            </span>
            {clipPlaying ? (
              <button className="btn btn--danger btn--sm" onClick={stopClip}>
                Stop
              </button>
            ) : (
              <button
                className="btn btn--primary btn--sm"
                onClick={playClip}
                disabled={!ready}
                title={ready ? undefined : 'Start a duplex session first (needs a reference voice)'}
              >
                ▶ Play into session
              </button>
            )}
          </div>
        )}
        {clipName && !ready && !clipPlaying && (
          <div className="drawer__note">
            Clip loaded — <b>Start session</b> below (reference voice required) to play it into the
            model.
          </div>
        )}
        <div className="drawer__note">
          Replays a recorded clip into the live session at realtime pace (200 ms chunks), as if it
          were your mic — the mic is paused while a clip plays.
        </div>
        <div className="section-title">events</div>
        <div
          ref={logRef}
          className="input--mono"
          style={{
            fontSize: 11,
            lineHeight: 1.6,
            maxHeight: 220,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            opacity: events.length ? 1 : 0.5,
          }}
        >
          {events.length ? events.join('\n') : 'server events appear here'}
        </div>
        <div className="drawer__note">
          <b>Full duplex</b>: audio streams up continuously (PCM16 @ 16 kHz); the server emits{' '}
          <code>response.listen</code> / <code>response.speak</code> decisions on its own and the
          reply streams back as text + voice (24 kHz). Playback is committed with{' '}
          <code>playback.ack</code> after it finishes playing.
        </div>
        <div className="drawer__note">
          Uses the model selected top-right (<b>{settings.model || 'none'}</b>). Requires a server
          started with native duplex enabled. First response warms up slowly.
        </div>
        <button
          className="btn btn--ghost btn--sm"
          onClick={() =>
            setTurns((cur) => {
              cur.forEach((t) => t.audioUrl && URL.revokeObjectURL(t.audioUrl))
              return []
            })
          }
          disabled={turns.length === 0}
        >
          Clear transcript
        </button>
      </aside>
    </div>
  )
}
