import { useState } from 'react'
import { generateImages } from '../lib/client'
import { downloadDataURL, fmtSeconds, useSettings } from '../lib/store'
import type { ImageGenRequest } from '../lib/types'
import { Empty, ErrorBanner, Field, NumInput } from '../components/Field'

const SIZES = ['512x512', '768x768', '1024x1024', '1280x720', '720x1280', '1024x768']

interface GenResult {
  key: string
  prompt: string
  images: string[] // data URLs
  size?: string
  seed?: number | ''
  steps?: number | ''
  elapsedS: number
}

export function ImageGenPage() {
  const settings = useSettings()
  const [prompt, setPrompt] = useState('')
  const [negative, setNegative] = useState('')
  const [size, setSize] = useState('1024x1024')
  const [n, setN] = useState<number | ''>(1)
  const [steps, setSteps] = useState<number | ''>('')
  const [guidance, setGuidance] = useState<number | ''>('')
  const [trueCfg, setTrueCfg] = useState<number | ''>('')
  const [seed, setSeed] = useState<number | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<GenResult[]>([])

  async function run() {
    if (!prompt.trim() || busy) return
    setBusy(true)
    setError(null)
    const req: ImageGenRequest = {
      prompt: prompt.trim(),
      model: settings.model || undefined,
      n: n === '' ? 1 : n,
      size,
      response_format: 'b64_json',
    }
    if (negative.trim()) req.negative_prompt = negative.trim()
    if (steps !== '') req.num_inference_steps = steps
    if (guidance !== '') req.guidance_scale = guidance
    if (trueCfg !== '') req.true_cfg_scale = trueCfg
    if (seed !== '') req.seed = seed
    const t0 = performance.now()
    try {
      const res = await generateImages(req)
      const images = res.data
        .map((d) => (d.b64_json ? `data:image/png;base64,${d.b64_json}` : d.url ?? ''))
        .filter(Boolean)
      setResults((cur) => [
        {
          key: `${Date.now()}`,
          prompt: req.prompt,
          images,
          size,
          seed,
          steps,
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
        <Field label="prompt">
          <textarea
            className="textarea"
            value={prompt}
            placeholder="A rusty lighthouse at dusk, volumetric fog, film photography…"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>
        <Field label="negative prompt">
          <textarea
            className="textarea"
            style={{ minHeight: 52 }}
            value={negative}
            placeholder="(optional)"
            onChange={(e) => setNegative(e.target.value)}
          />
        </Field>
        <div className="row">
          <Field label="size">
            <select className="select" value={size} onChange={(e) => setSize(e.target.value)}>
              {SIZES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="count">
            <NumInput value={n} min={1} max={8} onChange={setN} />
          </Field>
        </div>
        <details className="adv">
          <summary>advanced</summary>
          <div className="adv__body">
            <div className="row">
              <Field label="steps">
                <NumInput value={steps} min={1} placeholder="model default" onChange={setSteps} />
              </Field>
              <Field label="seed">
                <NumInput value={seed} placeholder="random" onChange={setSeed} />
              </Field>
            </div>
            <div className="row">
              <Field label="guidance scale">
                <NumInput value={guidance} step={0.1} placeholder="default" onChange={setGuidance} />
              </Field>
              <Field label="true cfg scale">
                <NumInput value={trueCfg} step={0.1} placeholder="default" onChange={setTrueCfg} />
              </Field>
            </div>
          </div>
        </details>
        <ErrorBanner error={error} />
        <button className="btn btn--primary" onClick={run} disabled={busy || !prompt.trim()}>
          {busy ? 'Developing…' : 'Generate'}
        </button>
        {busy && (
          <div className="progress">
            <div className="progress__bar" style={{ width: '100%' }} />
          </div>
        )}
      </div>

      <div className="workbench__results">
        {results.length === 0 ? (
          <Empty title="nothing developed yet">
            Generated images appear here with their parameters, ready to download.
          </Empty>
        ) : (
          <div className="results-grid">
            {results.flatMap((r) =>
              r.images.map((src, i) => (
                <div key={`${r.key}-${i}`} className="card">
                  <a className="card__media" href={src} target="_blank" rel="noreferrer">
                    <img src={src} alt={r.prompt} />
                  </a>
                  <div className="card__body">
                    <div className="card__prompt" title={r.prompt}>
                      {r.prompt}
                    </div>
                    <div className="card__row">
                      <span className="meta">
                        <b>{r.size}</b>
                        {r.steps !== '' && r.steps != null ? ` · ${r.steps} steps` : ''}
                        {r.seed !== '' && r.seed != null ? ` · seed ${r.seed}` : ''} ·{' '}
                        {fmtSeconds(r.elapsedS)}
                      </span>
                      <button
                        className="btn btn--sm btn--ghost"
                        style={{ marginLeft: 'auto' }}
                        onClick={() => downloadDataURL(src, `omni-${r.key}-${i}.png`)}
                      >
                        Download
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
