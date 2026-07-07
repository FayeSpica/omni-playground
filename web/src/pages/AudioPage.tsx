import { useCallback, useEffect, useState } from 'react'
import {
  deleteVoice,
  generateAudio,
  listVoices,
  speak,
  uploadVoice,
  type VoicesResponse,
} from '../lib/client'
import { speakStream } from '../lib/streams'
import { fileToDataURL, fmtSeconds, useSettings } from '../lib/store'
import { Empty, ErrorBanner, Field, NumInput } from '../components/Field'
import { FileDrop, type PickedFile } from '../components/FileDrop'

type Mode = 'speech' | 'generate'

interface AudioResult {
  key: string
  mode: Mode
  input: string
  voice?: string
  url: string
  elapsedS: number
}

export function AudioPage() {
  const settings = useSettings()
  const [mode, setMode] = useState<Mode>('speech')
  const [voices, setVoices] = useState<VoicesResponse>({ voices: [], uploaded_voices: [] })

  // speech state
  const [input, setInput] = useState('')
  const [voice, setVoice] = useState('')
  const [speed, setSpeed] = useState(1)
  const [instructions, setInstructions] = useState('')
  const [refAudio, setRefAudio] = useState<PickedFile[]>([])
  const [refAudioUrl, setRefAudioUrl] = useState('')
  const [refText, setRefText] = useState('')
  const [stream, setStream] = useState(false)

  // generate state
  const [genLength, setGenLength] = useState<number | ''>('')
  const [genSteps, setGenSteps] = useState<number | ''>('')
  const [genGuidance, setGenGuidance] = useState<number | ''>('')
  const [genNegative, setGenNegative] = useState('')

  const [seed, setSeed] = useState<number | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<AudioResult[]>([])

  const refreshVoices = useCallback(() => {
    listVoices()
      .then((v) => {
        setVoices(v)
        setVoice((cur) => cur || v.voices[0] || v.uploaded_voices[0]?.name || '')
      })
      .catch(() => setVoices({ voices: [], uploaded_voices: [] }))
  }, [])

  useEffect(refreshVoices, [refreshVoices])

  // Streaming TTS (/v1/audio/speech/stream WebSocket) — progressive playback.
  function runSpeechStream() {
    setBusy(true)
    setError(null)
    const t0 = performance.now()
    const key = `${Date.now()}`
    let lastUrl = ''
    const publish = (blob: Blob) => {
      const url = URL.createObjectURL(blob)
      if (lastUrl) URL.revokeObjectURL(lastUrl)
      lastUrl = url
      setResults((cur) =>
        cur.map((r) => (r.key === key ? { ...r, url, elapsedS: (performance.now() - t0) / 1000 } : r))
      )
    }
    setResults((cur) => [{ key, mode, input: input.trim(), voice, url: '', elapsedS: 0 }, ...cur])
    speakStream(
      {
        input: input.trim(),
        model: settings.model || undefined,
        voice: voice || undefined,
        speed,
        response_format: 'wav',
      },
      {
        onAudio: (blob) => publish(blob),
        onDone: (full) => {
          if (full) publish(full)
          setBusy(false)
        },
        onError: (msg) => {
          setError(msg)
          setBusy(false)
        },
      }
    )
  }

  async function run() {
    if (!input.trim() || busy) return
    if (mode === 'speech' && stream) return runSpeechStream()
    setBusy(true)
    setError(null)
    const t0 = performance.now()
    try {
      let blob: Blob
      if (mode === 'speech') {
        const ref =
          refAudioUrl.trim() || (refAudio[0] ? await fileToDataURL(refAudio[0].file) : undefined)
        blob = await speak({
          input: input.trim(),
          model: settings.model || undefined,
          voice: voice || undefined,
          speed,
          seed: seed === '' ? undefined : seed,
          instructions: instructions.trim() || undefined,
          ref_audio: ref,
          ref_text: refText.trim() || undefined,
          response_format: 'wav',
        })
      } else {
        blob = await generateAudio({
          input: input.trim(),
          model: settings.model || undefined,
          audio_length: genLength === '' ? undefined : genLength,
          num_inference_steps: genSteps === '' ? undefined : genSteps,
          guidance_scale: genGuidance === '' ? undefined : genGuidance,
          seed: seed === '' ? undefined : seed,
          negative_prompt: genNegative.trim() || undefined,
          response_format: 'wav',
        })
      }
      setResults((cur) => [
        {
          key: `${Date.now()}`,
          mode,
          input: input.trim(),
          voice: mode === 'speech' ? voice : undefined,
          url: URL.createObjectURL(blob),
          elapsedS: (performance.now() - t0) / 1000,
        },
        ...cur,
      ])
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="workbench">
      <div className="workbench__form">
        <div className="row">
          <button
            className={`btn${mode === 'speech' ? ' btn--primary' : ''}`}
            onClick={() => setMode('speech')}
          >
            Speech · TTS
          </button>
          <button
            className={`btn${mode === 'generate' ? ' btn--primary' : ''}`}
            onClick={() => setMode('generate')}
          >
            Sound · Music
          </button>
        </div>

        <Field label={mode === 'speech' ? 'text to speak' : 'sound description'}>
          <textarea
            className="textarea"
            value={input}
            placeholder={
              mode === 'speech'
                ? '你好，欢迎来到多模态暗房。'
                : 'rain on a tin roof, distant thunder, lo-fi…'
            }
            onChange={(e) => setInput(e.target.value)}
          />
        </Field>

        {mode === 'speech' ? (
          <>
            <div className="row">
              <Field label="voice">
                <select className="select" value={voice} onChange={(e) => setVoice(e.target.value)}>
                  <option value="">(model default)</option>
                  {voices.voices
                    .filter((v) => !voices.uploaded_voices.some((u) => u.name === v))
                    .map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  {voices.uploaded_voices.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name} (uploaded)
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="speed" hint={`${speed.toFixed(2)}×`}>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                />
              </Field>
            </div>
            <label
              style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text-dim)' }}
            >
              <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} />
              stream (progressive playback via /v1/audio/speech/stream)
            </label>
            <details className="adv">
              <summary>voice clone & style</summary>
              <div className="adv__body">
                <Field label="instructions" hint="speaking style">
                  <input
                    className="input"
                    value={instructions}
                    placeholder="whisper, excited, news anchor…"
                    onChange={(e) => setInstructions(e.target.value)}
                  />
                </Field>
                <Field label="reference audio" hint="zero-shot clone">
                  <FileDrop
                    accept="audio/*"
                    files={refAudio}
                    onChange={setRefAudio}
                    label="drop a reference clip (3–10s), or click"
                  />
                </Field>
                <Field label="…or reference url / path">
                  <input
                    className="input input--mono"
                    value={refAudioUrl}
                    onChange={(e) => setRefAudioUrl(e.target.value)}
                  />
                </Field>
                <Field label="reference transcript">
                  <input
                    className="input"
                    value={refText}
                    placeholder="what the reference clip says"
                    onChange={(e) => setRefText(e.target.value)}
                  />
                </Field>
                <Field label="seed">
                  <NumInput value={seed} placeholder="random" onChange={setSeed} />
                </Field>
              </div>
            </details>
            <VoiceManager voices={voices} onChanged={refreshVoices} />
          </>
        ) : (
          <details className="adv" open>
            <summary>generation params</summary>
            <div className="adv__body">
              <div className="row--3 row">
                <Field label="length (s)">
                  <NumInput value={genLength} min={1} placeholder="auto" onChange={setGenLength} />
                </Field>
                <Field label="steps">
                  <NumInput value={genSteps} min={1} placeholder="default" onChange={setGenSteps} />
                </Field>
                <Field label="seed">
                  <NumInput value={seed} placeholder="random" onChange={setSeed} />
                </Field>
              </div>
              <Field label="guidance scale">
                <NumInput value={genGuidance} step={0.1} placeholder="default" onChange={setGenGuidance} />
              </Field>
              <Field label="negative prompt">
                <input
                  className="input"
                  value={genNegative}
                  onChange={(e) => setGenNegative(e.target.value)}
                />
              </Field>
            </div>
          </details>
        )}

        <ErrorBanner error={error} />
        <button className="btn btn--primary" onClick={run} disabled={busy || !input.trim()}>
          {busy ? 'Rendering…' : mode === 'speech' ? 'Speak' : 'Generate audio'}
        </button>
        {busy && (
          <div className="progress">
            <div className="progress__bar" style={{ width: '100%' }} />
          </div>
        )}
      </div>

      <div className="workbench__results">
        {results.length === 0 ? (
          <Empty title="no audio yet">
            Rendered speech and generated sound land here — play inline or download as WAV.
          </Empty>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
            {results.map((r) => (
              <div key={r.key} className="card">
                <div className="card__body">
                  <div className="card__row">
                    <span className={`chip chip--completed`}>
                      {r.mode === 'speech' ? 'speech' : 'sound'}
                    </span>
                    {r.voice && <span className="meta">voice <b>{r.voice}</b></span>}
                    <span className="meta">{fmtSeconds(r.elapsedS)}</span>
                    <a
                      className="btn btn--sm btn--ghost"
                      style={{ marginLeft: 'auto' }}
                      href={r.url}
                      download={`omni-${r.mode}-${r.key}.wav`}
                    >
                      Download
                    </a>
                  </div>
                  <div className="card__prompt" title={r.input}>
                    {r.input}
                  </div>
                  <audio src={r.url} controls style={{ width: '100%' }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function VoiceManager({ voices, onChanged }: { voices: VoicesResponse; onChanged: () => void }) {
  const [name, setName] = useState('')
  const [sample, setSample] = useState<PickedFile[]>([])
  const [refText, setRefText] = useState('')
  const [consent, setConsent] = useState(false)
  const [msg, setMsg] = useState('')

  async function upload() {
    if (!name.trim() || !consent) return
    const form = new FormData()
    form.append('name', name.trim())
    form.append('consent', 'true')
    if (sample[0]) form.append('audio_sample', sample[0].file, sample[0].file.name)
    if (refText.trim()) form.append('ref_text', refText.trim())
    try {
      await uploadVoice(form)
      setMsg('voice uploaded')
      setName('')
      setSample([])
      setRefText('')
      onChanged()
    } catch (e) {
      setMsg(String((e as Error).message ?? e).slice(0, 120))
    }
    setTimeout(() => setMsg(''), 4000)
  }

  return (
    <details className="adv">
      <summary>voice library</summary>
      <div className="adv__body">
        {voices.uploaded_voices.length > 0 && (
          <div className="card__row">
            {voices.uploaded_voices.map((v) => (
              <span key={v.name} className="drop__file" title={v.ref_text ?? undefined}>
                {v.name}
                <button
                  className="rm"
                  style={{ position: 'static' }}
                  onClick={() =>
                    deleteVoice(v.name)
                      .then(onChanged)
                      .catch((e) => setMsg(String(e.message ?? e).slice(0, 120)))
                  }
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <Field label="new voice name" hint={msg}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="voice sample">
          <FileDrop
            accept="audio/*"
            files={sample}
            onChange={setSample}
            label="drop a clean voice sample"
          />
        </Field>
        <Field label="sample transcript">
          <input className="input" value={refText} onChange={(e) => setRefText(e.target.value)} />
        </Field>
        <label
          style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: 'var(--text-dim)' }}
        >
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          I have the speaker's consent to clone this voice
        </label>
        <button className="btn btn--sm" onClick={upload} disabled={!name.trim() || !consent}>
          Upload voice
        </button>
      </div>
    </details>
  )
}
