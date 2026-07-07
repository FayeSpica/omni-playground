import type { ReactNode } from 'react'

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="field">
      <div className="field__label">
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

export function NumInput({
  value,
  onChange,
  placeholder,
  step,
  min,
  max,
}: {
  value: number | ''
  onChange: (v: number | '') => void
  placeholder?: string
  step?: number
  min?: number
  max?: number
}) {
  return (
    <input
      className="input input--mono"
      type="number"
      value={value}
      placeholder={placeholder}
      step={step}
      min={min}
      max={max}
      onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
    />
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__mark" />
      <p className="k">{title}</p>
      {children && <p>{children}</p>}
    </div>
  )
}

export function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="error-banner">{error}</div>
}
