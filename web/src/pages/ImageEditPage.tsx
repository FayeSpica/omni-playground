import { useState } from 'react'
import { editImages } from '../lib/client'
import { downloadDataURL, fmtSeconds, useSettings } from '../lib/store'
import { Empty, ErrorBanner, Field, NumInput } from '../components/Field'
import { FileDrop, type PickedFile } from '../components/FileDrop'

interface EditResult {
  key: string
  prompt: string
  sourceUrls: string[]
  images: string[]
  elapsedS: number
}

export function ImageEditPage() {
  const settings = useSettings()
  const [files, setFiles] = useState<PickedFile[]>([])
  const [prompt, setPrompt] = useState('')
  const [negative, setNegative] = useState('')
  const [strength, setStrength] = useState<number | ''>('')
  const [steps, setSteps] = useState<number | ''>('')
  const [guidance, setGuidance] = useState<number | ''>('')
  const [seed, setSeed] = useState<number | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<EditResult[]>([])

  async function run() {
    if (!prompt.trim() || files.length === 0 || busy) return
    setBusy(true)
    setError(null)
    const form = new FormData()
    for (const f of files) form.append('image', f.file, f.file.name)
    form.append('prompt', prompt.trim())
    if (settings.model) form.append('model', settings.model)
    form.append('response_format', 'b64_json')
    if (negative.trim()) form.append('negative_prompt', negative.trim())
    if (strength !== '') form.append('strength', String(strength))
    if (steps !== '') form.append('num_inference_steps', String(steps))
    if (guidance !== '') form.append('guidance_scale', String(guidance))
    if (seed !== '') form.append('seed', String(seed))
    const t0 = performance.now()
    try {
      const res = await editImages(form)
      const images = res.data
        .map((d) => (d.b64_json ? `data:image/png;base64,${d.b64_json}` : d.url ?? ''))
        .filter(Boolean)
      setResults((cur) => [
        {
          key: `${Date.now()}`,
          prompt: prompt.trim(),
          sourceUrls: files.map((f) => f.previewUrl),
          images,
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
        <Field label="source image(s)">
          <FileDrop
            accept="image/*"
            multiple
            files={files}
            onChange={setFiles}
            label="drop images here, or click to browse"
          />
        </Field>
        <Field label="edit instruction">
          <textarea
            className="textarea"
            value={prompt}
            placeholder="Replace the sky with a thunderstorm; keep the subject unchanged…"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>
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
            <div className="row">
              <Field label="strength" hint="0–1">
                <NumInput
                  value={strength}
                  step={0.05}
                  min={0}
                  max={1}
                  placeholder="default"
                  onChange={setStrength}
                />
              </Field>
              <Field label="steps">
                <NumInput value={steps} min={1} placeholder="default" onChange={setSteps} />
              </Field>
            </div>
            <div className="row">
              <Field label="guidance scale">
                <NumInput value={guidance} step={0.1} placeholder="default" onChange={setGuidance} />
              </Field>
              <Field label="seed">
                <NumInput value={seed} placeholder="random" onChange={setSeed} />
              </Field>
            </div>
          </div>
        </details>
        <ErrorBanner error={error} />
        <button
          className="btn btn--primary"
          onClick={run}
          disabled={busy || !prompt.trim() || files.length === 0}
        >
          {busy ? 'Developing…' : 'Edit image'}
        </button>
        {busy && (
          <div className="progress">
            <div className="progress__bar" style={{ width: '100%' }} />
          </div>
        )}
      </div>

      <div className="workbench__results">
        {results.length === 0 ? (
          <Empty title="no edits yet">
            Upload an image, describe the change, and compare source with result here.
          </Empty>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            {results.map((r) => (
              <div key={r.key} className="card">
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${Math.min(r.sourceUrls.length + r.images.length, 4)}, 1fr)`,
                    gap: 1,
                    background: 'var(--line)',
                  }}
                >
                  {r.sourceUrls.map((src, i) => (
                    <div key={`s${i}`} style={{ position: 'relative', background: '#000' }}>
                      <img src={src} alt="source" style={{ width: '100%', display: 'block', opacity: 0.75 }} />
                      <span className="meta" style={{ position: 'absolute', top: 6, left: 8 }}>
                        source
                      </span>
                    </div>
                  ))}
                  {r.images.map((src, i) => (
                    <div key={`r${i}`} style={{ position: 'relative', background: '#000' }}>
                      <img src={src} alt="result" style={{ width: '100%', display: 'block' }} />
                      <span
                        className="meta"
                        style={{ position: 'absolute', top: 6, left: 8, color: 'var(--amber)' }}
                      >
                        result
                      </span>
                    </div>
                  ))}
                </div>
                <div className="card__body">
                  <div className="card__prompt">{r.prompt}</div>
                  <div className="card__row">
                    <span className="meta">{fmtSeconds(r.elapsedS)}</span>
                    {r.images.map((src, i) => (
                      <button
                        key={i}
                        className="btn btn--sm btn--ghost"
                        style={{ marginLeft: 'auto' }}
                        onClick={() => downloadDataURL(src, `omni-edit-${r.key}-${i}.png`)}
                      >
                        Download
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
