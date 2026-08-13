import { useEffect, useRef, useState } from 'react'
import { INPUT_RATE, MicCapture, base64ToPcm16, pcm16ChunksToWav } from '../lib/realtime'
import { fsList, fsRead, fsSave, type FsEntry } from '../lib/client'
import {
  hasDirPermission,
  listNativeAudio,
  loadDirectory,
  pickDirectory,
  readNativeFile,
  requestDirPermission,
  supportsNativeDir,
  writeNativeFile,
} from '../lib/fsdir'
import { fmtSeconds } from '../lib/store'
import { ErrorBanner, Field } from '../components/Field'
import { DirPicker } from '../components/DirPicker'

const DEFAULT_DIR = '/tmp/omni-recordings'
const DIR_KEY = 'omni-playground:record-dir'

function defaultName(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14)
  return `rec-${stamp}.wav`
}

export function RecordPage() {
  const [recording, setRecording] = useState(false)
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [duration, setDuration] = useState(0)
  const [dir, setDir] = useState(() => localStorage.getItem(DIR_KEY) || DEFAULT_DIR)
  const [name, setName] = useState(defaultName)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [files, setFiles] = useState<FsEntry[]>([])
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null)

  const micRef = useRef<MicCapture | null>(null)
  const chunksRef = useRef<string[]>([])
  const blobRef = useRef<Blob | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function refreshFiles(handle = dirHandle) {
    try {
      setFiles(handle ? await listNativeAudio(handle) : await fsList(dir))
    } catch {
      setFiles([])
    }
  }

  useEffect(() => {
    localStorage.setItem(DIR_KEY, dir)
    if (!dirHandle) refreshFiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir])

  // Restore the previously picked native directory (shared with the Duplex page).
  useEffect(() => {
    if (!supportsNativeDir) return
    loadDirectory().then(async (handle) => {
      if (!handle || !(await hasDirPermission(handle, true))) return
      setDirHandle(handle)
      refreshFiles(handle)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function chooseDirectory() {
    const handle = await pickDirectory()
    if (!handle) return
    if (!(await requestDirPermission(handle, true))) {
      setError('directory access was not granted')
      return
    }
    setDirHandle(handle)
    refreshFiles(handle)
  }

  async function startRecording() {
    setError(null)
    setSavedPath(null)
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setAudioUrl(null)
    blobRef.current = null
    chunksRef.current = []
    setElapsed(0)
    const mic = new MicCapture()
    micRef.current = mic
    try {
      await mic.start(
        (b64) => chunksRef.current.push(b64),
        (lvl) => setLevel(lvl)
      )
      setRecording(true)
      const started = Date.now()
      timerRef.current = setInterval(() => setElapsed((Date.now() - started) / 1000), 250)
    } catch (e) {
      setError(`microphone: ${(e as Error).message ?? e}`)
      mic.stop()
      micRef.current = null
    }
  }

  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    micRef.current?.stop()
    micRef.current = null
    setRecording(false)
    setLevel(0)
    const blob = pcm16ChunksToWav(chunksRef.current, INPUT_RATE)
    if (!blob) return
    blobRef.current = blob
    setDuration(
      chunksRef.current.reduce((n, c) => n + base64ToPcm16(c).length, 0) / INPUT_RATE
    )
    setAudioUrl(URL.createObjectURL(blob))
  }

  async function save() {
    const blob = blobRef.current
    if (!blob || saving) return
    setSaving(true)
    setError(null)
    try {
      const filename = name.trim().endsWith('.wav') ? name.trim() : `${name.trim()}.wav`
      if (dirHandle) {
        if (!(await requestDirPermission(dirHandle, true))) {
          throw new Error('directory access was not granted')
        }
        await writeNativeFile(dirHandle, filename, blob)
        // the File System Access API doesn't expose the absolute path
        setSavedPath(`${dirHandle.name}/${filename}`)
      } else {
        const path = await fsSave(dir.trim(), filename, blob)
        setSavedPath(path)
      }
      setName(defaultName())
      refreshFiles()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setSaving(false)
    }
  }

  async function preview(entry: FsEntry) {
    setError(null)
    try {
      const blob = dirHandle
        ? await readNativeFile(dirHandle, entry.name)
        : await fsRead(`${dir.replace(/\/$/, '')}/${entry.name}`)
      if (audioUrl) URL.revokeObjectURL(audioUrl)
      blobRef.current = blob
      setDuration(0)
      setName(entry.name)
      setAudioUrl(URL.createObjectURL(blob))
      setSavedPath(null)
    } catch (e) {
      setError(String((e as Error).message ?? e))
    }
  }

  // Tear the mic down if the page unmounts mid-recording.
  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current)
      micRef.current?.stop()
    },
    []
  )

  return (
    <div className="workbench">
      <div className="workbench__form">
        <div className="section-title">microphone</div>
        <div className="row" style={{ alignItems: 'center' }}>
          <div className="rt-meter" title="mic level" style={{ flex: 1 }}>
            <div
              className="rt-meter__fill"
              style={{ width: recording ? `${Math.round(level * 100)}%` : '0%' }}
            />
          </div>
          <span className="meta" style={{ minWidth: 64 }}>
            {recording ? `◉ ${fmtSeconds(elapsed)}` : 'idle'}
          </span>
          {recording ? (
            <button className="btn btn--danger" onClick={stopRecording}>
              Stop
            </button>
          ) : (
            <button className="btn btn--primary" onClick={startRecording}>
              Record
            </button>
          )}
        </div>
        <div className="drawer__note">
          Records the mic as mono PCM16 @ {INPUT_RATE / 1000} kHz WAV — the exact format the
          realtime / duplex endpoints consume.
        </div>

        <div className="section-title" style={{ marginTop: 18 }}>
          save to directory
        </div>
        {supportsNativeDir ? (
          <>
            <div className="row" style={{ alignItems: 'center' }}>
              <button className="btn btn--primary" onClick={chooseDirectory}>
                Choose directory…
              </button>
              <span className="meta input--mono" style={{ fontSize: 12 }}>
                {dirHandle ? dirHandle.name : 'no directory chosen'}
              </span>
            </div>
            <div className="drawer__note">
              Uses the browser-native directory picker — recordings are written straight into the
              folder you choose, and the Duplex page reads clips from the same folder.
            </div>
          </>
        ) : (
          <>
            <Field label="directory" hint="on the machine running omni-playground">
              <input
                className="input input--mono"
                value={dir}
                placeholder={DEFAULT_DIR}
                onChange={(e) => setDir(e.target.value)}
              />
            </Field>
            <DirPicker value={dir} onSelect={setDir} />
          </>
        )}
        <Field label="filename">
          <input
            className="input input--mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="row">
          <button className="btn btn--primary" onClick={save} disabled={!audioUrl || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {audioUrl && (
            <a className="btn btn--ghost" href={audioUrl} download={name}>
              Download
            </a>
          )}
        </div>
        <ErrorBanner error={error} />
        {savedPath && <div className="drawer__note">saved → <code>{savedPath}</code></div>}
      </div>

      <div className="workbench__results">
        <div className="section-title">preview</div>
        {audioUrl ? (
          <>
            <audio src={audioUrl} controls style={{ width: '100%' }} />
            {duration > 0 && <div className="meta">{fmtSeconds(duration)}</div>}
          </>
        ) : (
          <div className="drawer__note">Nothing recorded yet — press Record and talk.</div>
        )}

        <div className="section-title" style={{ marginTop: 18 }}>
          in {dirHandle ? dirHandle.name : dir || DEFAULT_DIR}
          <button
            className="btn btn--ghost btn--sm"
            style={{ marginLeft: 8 }}
            onClick={() => refreshFiles()}
          >
            Refresh
          </button>
        </div>
        {files.length === 0 ? (
          <div className="drawer__note">No audio files found in this directory.</div>
        ) : (
          files.map((f) => (
            <div key={f.name} className="row" style={{ justifyContent: 'space-between' }}>
              <span className="meta input--mono" style={{ fontSize: 12 }}>
                {f.name}
              </span>
              <span className="meta">{(f.size / 1024).toFixed(0)} KB</span>
              <button className="btn btn--ghost btn--sm" onClick={() => preview(f)}>
                Preview
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
