import { useSyncExternalStore } from 'react'

export interface Settings {
  apiKey: string
  model: string
}

const KEY = 'omni-playground:settings'

let settings: Settings = { apiKey: '', model: '' }
try {
  settings = { ...settings, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
} catch {
  /* corrupted localStorage — fall back to defaults */
}

const listeners = new Set<() => void>()

export function getSettings(): Settings {
  return settings
}

export function updateSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch }
  localStorage.setItem(KEY, JSON.stringify(settings))
  listeners.forEach((l) => l())
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => settings
  )
}

// —— tiny helpers shared by pages ——

export function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

export function downloadDataURL(dataUrl: string, filename: string) {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  a.click()
}

export function fmtSeconds(s: number | null | undefined): string {
  if (s == null) return '—'
  return s >= 60 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${s.toFixed(1)}s`
}
