import { useEffect, useState } from 'react'
import {
  checkHealth,
  getProxyTarget,
  listModels,
  omniSleep,
  omniWakeup,
  setProxyTarget,
  type OmniPowerResponse,
} from './lib/client'
import { updateSettings, useSettings } from './lib/store'
import type { ModelInfo } from './lib/types'
import { Field } from './components/Field'
import { ChatPage } from './pages/ChatPage'
import { ImageGenPage } from './pages/ImageGenPage'
import { ImageEditPage } from './pages/ImageEditPage'
import { VideoPage } from './pages/VideoPage'
import { AudioPage } from './pages/AudioPage'
import { RealtimePage } from './pages/RealtimePage'
import { VideoChatPage } from './pages/VideoChatPage'

const PAGES = [
  { id: 'realtime', idx: '01', label: 'Realtime', title: 'Realtime Voice', sub: '/v1/realtime' },
  { id: 'chat', idx: '02', label: 'Chat', title: 'Omni Chat', sub: '/v1/chat/completions' },
  { id: 'image', idx: '03', label: 'Image', title: 'Text to Image', sub: '/v1/images/generations' },
  { id: 'edit', idx: '04', label: 'Edit', title: 'Image Edit', sub: '/v1/images/edits' },
  { id: 'video', idx: '05', label: 'Video', title: 'Video Generation', sub: '/v1/videos' },
  { id: 'audio', idx: '06', label: 'Audio', title: 'Speech & Sound', sub: '/v1/audio/speech · /v1/audio/generate' },
  { id: 'videochat', idx: '07', label: 'Vid Chat', title: 'Video Chat', sub: '/v1/video/chat/stream · /v1/realtime/video' },
] as const

type PageId = (typeof PAGES)[number]['id']

function pageFromHash(): PageId {
  const id = location.hash.replace(/^#\/?/, '')
  return (PAGES.some((p) => p.id === id) ? id : PAGES[0].id) as PageId
}

export function App() {
  const [page, setPageState] = useState<PageId>(pageFromHash)
  const setPage = (id: PageId) => {
    location.hash = `/${id}`
    setPageState(id)
  }

  useEffect(() => {
    const onHash = () => setPageState(pageFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const [online, setOnline] = useState<boolean | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const settings = useSettings()

  async function refresh() {
    const ok = await checkHealth()
    setOnline(ok)
    if (ok) {
      try {
        const list = await listModels()
        setModels(list)
        if (list.length && !list.some((m) => m.id === settings.model)) {
          updateSettings({ model: list[0].id })
        }
      } catch {
        /* models endpoint may be gated by auth; LED already reflects health */
      }
    }
  }

  useEffect(() => {
    refresh()
    getProxyTarget().then(setTarget)
    const t = setInterval(() => checkHealth().then(setOnline), 12000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const current = PAGES.find((p) => p.id === page)!

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail__brand">
          omni<em>—</em>playground
          <small>multimodal darkroom</small>
        </div>
        <div className="rail__nav">
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={`rail__item${page === p.id ? ' is-active' : ''}`}
              onClick={() => setPage(p.id)}
            >
              <span className="idx">{p.idx}</span>
              {p.label}
            </button>
          ))}
        </div>
        <div className="rail__foot">
          <button className="btn btn--ghost btn--sm" onClick={() => setDrawerOpen(true)}>
            Settings
          </button>
          <div
            className="rail__conn"
            title={target ? `proxy → ${target}` : 'dev proxy'}
            onClick={refresh}
            style={{ cursor: 'pointer' }}
          >
            <span className={`led ${online == null ? '' : online ? 'led--on' : 'led--off'}`} />
            {online == null ? 'probing…' : online ? (settings.model || 'connected') : 'unreachable'}
          </div>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <h1>{current.title}</h1>
          <span className="topbar__sub">{current.sub}</span>
          <div className="topbar__right">
            {models.length > 1 && (
              <select
                className="select"
                style={{ width: 260 }}
                value={settings.model}
                onChange={(e) => updateSettings({ model: e.target.value })}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            )}
          </div>
        </header>

        {page === 'chat' && <ChatPage />}
        {page === 'image' && <ImageGenPage />}
        {page === 'edit' && <ImageEditPage />}
        {page === 'video' && <VideoPage />}
        {page === 'audio' && <AudioPage />}
        {page === 'realtime' && <RealtimePage />}
        {page === 'videochat' && <VideoChatPage />}
      </div>

      {drawerOpen && (
        <SettingsDrawer
          target={target}
          onTargetSaved={(t) => {
            setTarget(t)
            refresh()
          }}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </div>
  )
}

function summarizePower(r: OmniPowerResponse): string {
  if (r.status !== 'SUCCESS') return `${r.status}${r.reason ? ` — ${r.reason}` : ''}`
  const unsupported = (r.acks ?? []).filter((a) => a.supported === false)
  if (unsupported.length) {
    const err = unsupported[0].error?.split('\n')[0]?.slice(0, 140)
    return `SUCCESS, but ${unsupported.length} stage(s) unsupported${err ? ` — ${err}` : ''}`
  }
  return 'SUCCESS'
}

function GpuMemory() {
  const [stages, setStages] = useState('0')
  const [level, setLevel] = useState(2)
  const [busy, setBusy] = useState<null | 'sleep' | 'wake'>(null)
  const [msg, setMsg] = useState('')

  const stageIds = () =>
    stages
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n))

  async function run(kind: 'sleep' | 'wake') {
    const ids = stageIds()
    if (!ids.length || busy) return
    setBusy(kind)
    setMsg('working…')
    try {
      const r = kind === 'sleep' ? await omniSleep(ids, level) : await omniWakeup(ids)
      setMsg(summarizePower(r))
    } catch (e) {
      setMsg(String((e as Error).message ?? e).slice(0, 180))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="section-title" style={{ marginTop: 18 }}>gpu memory</div>
      <div className="row">
        <Field label="stage ids" hint="comma-separated">
          <input
            className="input input--mono"
            value={stages}
            placeholder="0"
            onChange={(e) => setStages(e.target.value)}
          />
        </Field>
        <Field label="sleep level" hint="2 frees more">
          <select
            className="select"
            value={level}
            onChange={(e) => setLevel(Number(e.target.value))}
          >
            <option value={1}>1 · offload</option>
            <option value={2}>2 · free</option>
          </select>
        </Field>
      </div>
      <div className="row">
        <button className="btn btn--sm" onClick={() => run('sleep')} disabled={!!busy}>
          {busy === 'sleep' ? 'Sleeping…' : 'Sleep'}
        </button>
        <button className="btn btn--sm" onClick={() => run('wake')} disabled={!!busy}>
          {busy === 'wake' ? 'Waking…' : 'Wake up'}
        </button>
      </div>
      {msg && <div className="drawer__note">{msg}</div>}
      <div className="drawer__note">
        Offload pipeline stages to free VRAM between runs, then wake them before the next request.
        Stage ids are model-specific (stage 0 is the main model).
      </div>
    </>
  )
}

function SettingsDrawer({
  target,
  onTargetSaved,
  onClose,
}: {
  target: string | null
  onTargetSaved: (t: string) => void
  onClose: () => void
}) {
  const settings = useSettings()
  const [draft, setDraft] = useState(target ?? '')
  const [saveMsg, setSaveMsg] = useState('')

  async function saveTarget() {
    const ok = await setProxyTarget(draft)
    if (ok) {
      onTargetSaved(draft)
      setSaveMsg('saved')
    } else {
      setSaveMsg('failed — invalid URL?')
    }
    setTimeout(() => setSaveMsg(''), 2500)
  }

  return (
    <>
      <div className="drawer-veil" onClick={onClose} />
      <aside className="drawer">
        <h2>Settings</h2>
        <Field label="vLLM-omni target" hint={saveMsg}>
          <input
            className="input input--mono"
            value={draft}
            placeholder="http://127.0.0.1:8091"
            onChange={(e) => setDraft(e.target.value)}
          />
        </Field>
        <button className="btn" onClick={saveTarget} disabled={!draft}>
          Apply target
        </button>
        <div className="drawer__note">
          Requests are proxied through the local omni-playground server, so the browser never
          talks to the inference host directly (no CORS setup needed).
        </div>
        <Field label="API key" hint="sent as Bearer token">
          <input
            className="input input--mono"
            type="password"
            value={settings.apiKey}
            placeholder="(empty — no auth)"
            onChange={(e) => updateSettings({ apiKey: e.target.value })}
          />
        </Field>
        <GpuMemory />
        <button className="btn btn--ghost" onClick={onClose} style={{ marginTop: 'auto' }}>
          Close
        </button>
      </aside>
    </>
  )
}
