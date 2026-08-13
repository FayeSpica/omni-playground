import { useEffect, useState } from 'react'
import { fsBrowse, type FsBrowseResult } from '../lib/client'

function joinPath(base: string, name: string): string {
  return `${base.replace(/\/+$/, '')}/${name}`
}

/**
 * Visual directory picker for paths on the playground server's host.
 * Renders a "Browse…" toggle; the panel drills down into subdirectories and
 * commits the current path via onSelect.
 */
export function DirPicker({
  value,
  onSelect,
}: {
  value: string
  onSelect: (dir: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [cur, setCur] = useState('')
  const [info, setInfo] = useState<FsBrowseResult | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fsBrowse(cur || undefined).then((r) => {
      if (cancelled) return
      setInfo(r)
      setCur(r.path)
    })
    return () => {
      cancelled = true
    }
  }, [open, cur])

  function toggle() {
    if (!open) {
      setCur(value || '')
      setInfo(null)
    }
    setOpen((o) => !o)
  }

  return (
    <div>
      <button className="btn btn--ghost btn--sm" onClick={toggle}>
        {open ? 'Close browser' : 'Browse…'}
      </button>
      {open && (
        <div
          style={{
            marginTop: 8,
            border: '1px solid var(--line, #333)',
            borderRadius: 6,
            padding: 8,
          }}
        >
          <div className="meta input--mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
            {info?.path || cur || '…'}
          </div>
          <div style={{ maxHeight: 180, overflowY: 'auto', marginTop: 6 }}>
            {info?.parent && (
              <div className="row">
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => setCur(info.parent!)}
                >
                  ⬅ ..
                </button>
              </div>
            )}
            {info?.dirs.map((d) => (
              <div className="row" key={d}>
                <button
                  className="btn btn--ghost btn--sm input--mono"
                  style={{ fontSize: 12 }}
                  onClick={() => setCur(joinPath(info.path, d))}
                >
                  {d}/
                </button>
              </div>
            ))}
            {info && info.dirs.length === 0 && (
              <div className="drawer__note">
                {info.error ? `cannot list: ${info.error}` : 'no subdirectories'}
              </div>
            )}
            {!info && <div className="drawer__note">loading…</div>}
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <button
              className="btn btn--primary btn--sm"
              disabled={!info}
              onClick={() => {
                if (!info) return
                onSelect(info.path)
                setOpen(false)
              }}
            >
              Use this directory
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
