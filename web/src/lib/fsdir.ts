// Native directory access via the File System Access API (Chromium).
// The chosen directory handle is persisted in IndexedDB so the Record and
// Duplex pages share the same folder without re-picking. Falls back to the
// server-side /playground/fs endpoints when the API is unavailable.

export const supportsNativeDir =
  typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'

// Minimal ambient types — TS lib.dom has FileSystemDirectoryHandle but not
// the picker, permission helpers, or the async directory iterator.
declare global {
  interface Window {
    showDirectoryPicker?(opts?: {
      mode?: 'read' | 'readwrite'
    }): Promise<FileSystemDirectoryHandle>
  }
  interface FileSystemHandle {
    queryPermission?(desc: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
    requestPermission?(desc: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  }
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>
  }
}

const DB_NAME = 'omni-playground'
const STORE = 'fs'
const HANDLE_KEY = 'recordDir'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Open the native directory picker and persist the handle. Null = cancelled. */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!window.showDirectoryPicker) return null
  let handle: FileSystemDirectoryHandle
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite' })
  } catch {
    return null // user cancelled the picker
  }
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(handle, HANDLE_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* persistence failed — the in-memory handle still works this session */
  }
  return handle
}

/** Load the persisted handle, if any (permission may still need re-granting). */
export async function loadDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDb()
    const handle = await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(HANDLE_KEY)
      req.onsuccess = () => resolve(req.result as FileSystemDirectoryHandle | undefined)
      req.onerror = () => reject(req.error)
    })
    return handle ?? null
  } catch {
    return null
  }
}

/** Query permission without prompting (mount-time); ops re-request on click. */
export async function hasDirPermission(
  handle: FileSystemDirectoryHandle,
  write = false
): Promise<boolean> {
  if (!handle.queryPermission) return true
  return (await handle.queryPermission({ mode: write ? 'readwrite' : 'read' })) === 'granted'
}

/** Request permission from a user gesture; returns false when declined. */
export async function requestDirPermission(
  handle: FileSystemDirectoryHandle,
  write = false
): Promise<boolean> {
  if (await hasDirPermission(handle, write)) return true
  if (!handle.requestPermission) return false
  return (await handle.requestPermission({ mode: write ? 'readwrite' : 'read' })) === 'granted'
}

const AUDIO_EXT = /\.(wav|mp3|m4a|flac|ogg|opus|pcm)$/i

export interface NativeAudioEntry {
  name: string
  size: number
  mtime: number
}

export async function listNativeAudio(
  handle: FileSystemDirectoryHandle
): Promise<NativeAudioEntry[]> {
  const out: NativeAudioEntry[] = []
  for await (const entry of handle.values()) {
    if (entry.kind !== 'file' || !AUDIO_EXT.test(entry.name)) continue
    const file = await (entry as FileSystemFileHandle).getFile()
    out.push({ name: entry.name, size: file.size, mtime: file.lastModified })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

export async function readNativeFile(
  handle: FileSystemDirectoryHandle,
  name: string
): Promise<Blob> {
  const fh = await handle.getFileHandle(name)
  return fh.getFile()
}

export async function writeNativeFile(
  handle: FileSystemDirectoryHandle,
  name: string,
  blob: Blob
): Promise<void> {
  const fh = await handle.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(blob)
  await w.close()
}
