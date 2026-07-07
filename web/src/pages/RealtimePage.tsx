import { useEffect, useRef, useState } from 'react'
import {
  MicCapture,
  PcmPlayer,
  RealtimeSession,
  pcm16ChunksToWav,
  realtimeUrl,
} from '../lib/realtime'
import { getSettings, useSettings } from '../lib/store'
import { Empty, ErrorBanner, Field } from '../components/Field'

interface Turn {
  role: 'user' | 'assistant'
  text: string
  audioUrl?: string // assistant reply, merged WAV
}

type Phase = 'idle' | 'connecting' | 'ready'
type VadPhase = 'off' | 'idle' | 'listening' | 'waiting'

// VAD tuning. Mic level is RMS×4 clamped to 1 (see MicCapture).
const SILENCE_MS = 800 // trailing silence that ends a turn
const PREROLL_MS = 300 // audio kept before speech onset so the first word isn't clipped
const REARM_MS = 350 // wait after a reply before listening again (let the reply's audio tail drain)

interface VadState {
  phase: 'idle' | 'listening' | 'waiting'
  level: number
  silenceSince: number | null
  preRoll: { b64: string; t: number }[]
}

export function RealtimePage() {
  const settings = useSettings()
  const [phase, setPhase] = useState<Phase>('idle')
  const [auto, setAuto] = useState(true)
  const [recording, setRecording] = useState(false) // manual mode
  const [listening, setListening] = useState(false) // auto mode loop running
  const [vadPhase, setVadPhase] = useState<VadPhase>('off')
  const [speaking, setSpeaking] = useState(false)
  const [sensitivity, setSensitivity] = useState(0.5)
  const [turns, setTurns] = useState<Turn[]>([])
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState(0)

  const sessionRef = useRef<RealtimeSession | null>(null)
  const micRef = useRef<MicCapture | null>(null)
  const playerRef = useRef<PcmPlayer | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const turnAudioRef = useRef<{ chunks: string[]; rate: number }>({ chunks: [], rate: 24000 })
  const vadRef = useRef<VadState | null>(null)
  // mirrors of state read inside long-lived mic/session callbacks
  const autoRef = useRef(auto)
  autoRef.current = auto
  const sensitivityRef = useRef(sensitivity)
  sensitivityRef.current = sensitivity

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns])

  function appendAssistant(delta: string) {
    setTurns((cur) => {
      const next = [...cur]
      const last = next[next.length - 1]
      if (last?.role === 'assistant') next[next.length - 1] = { ...last, text: last.text + delta }
      else next.push({ role: 'assistant', text: delta })
      return next
    })
  }

  // higher sensitivity → lower onset threshold
  const onThreshold = () => Math.max(0.02, 0.11 - sensitivityRef.current * 0.08)

  function markUserSent() {
    setTurns((cur) =>
      cur.map((t, i) =>
        i === cur.length - 1 && t.role === 'user' ? { ...t, text: '🎙 voice message' } : t
      )
    )
  }

  // Re-arm the VAD loop for the next turn (called when a reply completes).
  // Small delay so the reply's own audio tail doesn't re-trigger a turn.
  function rearmVad() {
    if (!autoRef.current || !vadRef.current) return
    setTimeout(() => {
      const vad = vadRef.current
      if (!autoRef.current || !vad || vad.phase !== 'waiting') return
      vad.phase = 'idle'
      vad.silenceSince = null
      vad.preRoll = []
      setVadPhase('idle')
    }, REARM_MS)
  }

  function connect() {
    if (!settings.model) {
      setError('Select a model first (top-right) — the realtime endpoint needs one to validate.')
      return
    }
    setError(null)
    setPhase('connecting')
    const player = new PcmPlayer()
    playerRef.current = player
    const session = new RealtimeSession(
      realtimeUrl('/v1/realtime', { api_key: getSettings().apiKey || undefined }),
      settings.model,
      {
        onReady: () => setPhase('ready'),
        onText: (delta) => appendAssistant(delta),
        onAudio: (b64, rate) => {
          setSpeaking(true)
          const buf = turnAudioRef.current
          buf.chunks.push(b64)
          buf.rate = rate
          player.enqueue(b64, rate) // gapless live playback (independent of the bar)
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
        onTurnDone: () => setSpeaking(false),
        onAudioDone: () => {
          // reply fully received (server always sends this) — start next buffer, re-arm VAD
          turnAudioRef.current = { chunks: [], rate: 24000 }
          setSpeaking(false)
          rearmVad()
        },
        onError: (msg) => {
          setError(msg)
          // reset immediately from any phase so the loop isn't stuck
          const vad = vadRef.current
          if (autoRef.current && vad) {
            vad.phase = 'idle'
            vad.silenceSince = null
            vad.preRoll = []
            setVadPhase('idle')
          }
        },
        onClose: () => setPhase('idle'),
      }
    )
    sessionRef.current = session
    session.connect()
  }

  function disconnect() {
    micRef.current?.stop()
    playerRef.current?.close()
    sessionRef.current?.close()
    micRef.current = null
    playerRef.current = null
    sessionRef.current = null
    vadRef.current = null
    setPhase('idle')
    setRecording(false)
    setListening(false)
    setSpeaking(false)
    setVadPhase('off')
    setLevel(0)
  }

  // —— manual push-to-talk ——

  async function startRecording() {
    const session = sessionRef.current
    if (!session?.ready || recording) return
    setError(null)
    turnAudioRef.current = { chunks: [], rate: 24000 }
    session.startTurn()
    setTurns((cur) => [...cur, { role: 'user', text: '🎙 speaking…' }])
    const mic = new MicCapture()
    micRef.current = mic
    try {
      await mic.start(
        (b64) => session.appendAudio(b64),
        (lvl) => setLevel(lvl)
      )
      setRecording(true)
    } catch (e) {
      setError(`microphone: ${(e as Error).message ?? e}`)
      mic.stop()
    }
  }

  function stopRecording() {
    if (!recording) return
    micRef.current?.stop()
    micRef.current = null
    sessionRef.current?.endTurn()
    setRecording(false)
    setLevel(0)
    markUserSent()
  }

  // —— auto turn (client-side VAD) ——

  function handleAutoChunk(b64: string) {
    const vad = vadRef.current
    const session = sessionRef.current
    if (!vad || !session) return
    const now = performance.now()
    const on = onThreshold()
    const off = on * 0.6

    if (vad.phase === 'waiting') return // model is replying — ignore the mic

    if (vad.phase === 'idle') {
      vad.preRoll.push({ b64, t: now })
      while (vad.preRoll.length && now - vad.preRoll[0].t > PREROLL_MS) vad.preRoll.shift()
      if (vad.level > on) {
        vad.phase = 'listening'
        vad.silenceSince = null
        turnAudioRef.current = { chunks: [], rate: 24000 }
        session.startTurn()
        setVadPhase('listening')
        setTurns((cur) => [...cur, { role: 'user', text: '🎙 listening…' }])
        for (const p of vad.preRoll) session.appendAudio(p.b64) // flush pre-roll
        vad.preRoll = []
      }
      return
    }

    // listening
    session.appendAudio(b64)
    if (vad.level < off) {
      if (vad.silenceSince == null) vad.silenceSince = now
      else if (now - vad.silenceSince > SILENCE_MS) {
        vad.phase = 'waiting'
        vad.silenceSince = null
        session.endTurn()
        setVadPhase('waiting')
        markUserSent()
      }
    } else {
      vad.silenceSince = null
    }
  }

  async function startAuto() {
    const session = sessionRef.current
    if (!session?.ready || listening) return
    setError(null)
    const mic = new MicCapture()
    micRef.current = mic
    const vad: VadState = { phase: 'idle', level: 0, silenceSince: null, preRoll: [] }
    vadRef.current = vad
    try {
      await mic.start(
        (b64) => handleAutoChunk(b64),
        (lvl) => {
          vad.level = lvl
          setLevel(lvl)
        }
      )
      setListening(true)
      setVadPhase('idle')
    } catch (e) {
      setError(`microphone: ${(e as Error).message ?? e}`)
      mic.stop()
      micRef.current = null
      vadRef.current = null
    }
  }

  function stopAuto() {
    micRef.current?.stop()
    micRef.current = null
    vadRef.current = null
    setListening(false)
    setVadPhase('off')
    setLevel(0)
  }

  function switchMode(next: boolean) {
    if (next === auto) return
    if (recording) stopRecording()
    if (listening) stopAuto()
    setAuto(next)
  }

  // Tear everything down if the page unmounts mid-call.
  useEffect(() => () => disconnect(), [])

  const ready = phase === 'ready'
  const micLive = recording || listening
  const statusLabel =
    phase === 'connecting'
      ? 'connecting…'
      : !ready
        ? 'idle'
        : auto
          ? listening
            ? vadPhase === 'listening'
              ? '◉ hearing you'
              : vadPhase === 'waiting' || speaking
                ? '▶ replying'
                : '● waiting for you'
            : 'auto ready'
          : recording
            ? '◉ recording'
            : speaking
              ? '▶ speaking'
              : 'ready'

  return (
    <div className="chat">
      <div className="chat__main">
        <div className="chat__scroll" ref={scrollRef}>
          {turns.length === 0 ? (
            <Empty title={ready ? (auto ? 'auto mode — just start talking' : 'connected — hold the mic and talk') : 'not connected'}>
              {ready
                ? auto
                  ? 'Press “Start listening”, then just talk. It auto-detects when you stop (VAD), sends the turn, plays the reply, and re-arms for the next one — hands-free.'
                  : 'Press “Talk”, speak, then “Stop & send”. The omni model replies in text and voice.'
                : 'Voice chat over /v1/realtime. Connect, then talk — audio streams up as PCM16 @ 16 kHz and the reply streams back as text + voice.'}
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
                        download={`omni-reply-${i}.wav`}
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
                style={{ width: micLive ? `${Math.round(level * 100)}%` : '0%' }}
              />
            </div>
            <span className="meta" style={{ minWidth: 108 }}>
              {statusLabel}
            </span>
            {!ready ? (
              <button className="btn btn--primary" onClick={connect} disabled={phase === 'connecting'}>
                {phase === 'connecting' ? 'Connecting…' : 'Connect'}
              </button>
            ) : auto ? (
              listening ? (
                <button className="btn btn--danger" onClick={stopAuto}>
                  Stop listening
                </button>
              ) : (
                <button className="btn btn--primary" onClick={startAuto}>
                  Start listening
                </button>
              )
            ) : recording ? (
              <button className="btn btn--danger" onClick={stopRecording}>
                Stop &amp; send
              </button>
            ) : (
              <button className="btn btn--primary" onClick={startRecording} disabled={speaking}>
                Talk
              </button>
            )}
            {ready && (
              <button className="btn btn--ghost btn--sm" onClick={disconnect}>
                End
              </button>
            )}
          </div>
        </div>
      </div>

      <aside className="chat__aside">
        <div className="section-title">mode</div>
        <div className="row">
          <button
            className={`btn btn--sm${auto ? ' btn--primary' : ''}`}
            onClick={() => switchMode(true)}
          >
            Auto · VAD
          </button>
          <button
            className={`btn btn--sm${!auto ? ' btn--primary' : ''}`}
            onClick={() => switchMode(false)}
          >
            Push-to-talk
          </button>
        </div>
        {auto && (
          <Field label="sensitivity" hint={`${Math.round(sensitivity * 100)}%`}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={sensitivity}
              onChange={(e) => setSensitivity(Number(e.target.value))}
            />
          </Field>
        )}
        <div className="drawer__note">
          {auto ? (
            <>
              <b>Auto</b>: the mic stays open; speech starts a turn, ~{SILENCE_MS} ms of silence ends
              it, then it re-arms after the reply. Raise <b>sensitivity</b> if it misses quiet
              speech, lower it if background noise triggers turns.
            </>
          ) : (
            <>
              <b>Push-to-talk</b>: <b>Talk</b> streams your mic to the model; <b>Stop &amp; send</b>{' '}
              ends the turn and the reply streams back as text + voice.
            </>
          )}
        </div>
        <div className="drawer__note">
          Uses the model selected top-right (<b>{settings.model || 'none'}</b>), PCM16 @ 16 kHz up /
          24 kHz down. First reply warms up slowly on large models.
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
