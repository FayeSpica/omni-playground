import { useRef, useState } from 'react'

export interface PickedFile {
  file: File
  previewUrl: string
}

export function FileDrop({
  accept,
  multiple = false,
  files,
  onChange,
  label,
}: {
  accept: string
  multiple?: boolean
  files: PickedFile[]
  onChange: (files: PickedFile[]) => void
  label: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  function addFiles(list: FileList | null) {
    if (!list?.length) return
    const picked = Array.from(list).map((file) => ({
      file,
      previewUrl: URL.createObjectURL(file),
    }))
    onChange(multiple ? [...files, ...picked] : picked)
  }

  function removeAt(i: number) {
    URL.revokeObjectURL(files[i].previewUrl)
    onChange(files.filter((_, j) => j !== i))
  }

  return (
    <div
      className={`drop${over ? ' is-over' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        addFiles(e.dataTransfer.files)
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          addFiles(e.target.files)
          e.target.value = ''
        }}
      />
      {label}
      {files.length > 0 && (
        <div className="drop__thumbs" onClick={(e) => e.stopPropagation()}>
          {files.map((f, i) => {
            const kind = f.file.type.split('/')[0]
            return (
              <div key={f.previewUrl} className="drop__thumb">
                {kind === 'image' ? (
                  <img src={f.previewUrl} alt={f.file.name} />
                ) : kind === 'video' ? (
                  <video src={f.previewUrl} muted />
                ) : (
                  <span className="drop__file">{f.file.name.slice(0, 10)}</span>
                )}
                <button className="rm" onClick={() => removeAt(i)} title="remove">
                  ✕
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
