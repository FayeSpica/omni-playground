import type {
  ChatMessage,
  ImageGenRequest,
  ImagesResponse,
  ModelInfo,
  VideoJob,
  VideoListResponse,
} from './types'
import { getSettings } from './store'

const BASE = '/api'

function authHeaders(): Record<string, string> {
  const { apiKey } = getSettings()
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

async function fail(res: Response): Promise<never> {
  let detail = ''
  try {
    detail = await res.text()
  } catch {
    /* body already consumed or unreadable */
  }
  throw new Error(`HTTP ${res.status}${detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() })
  if (!res.ok) await fail(res)
  return res.json()
}

async function postJSON<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) await fail(res)
  return res.json()
}

async function postForm<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
    signal,
  })
  if (!res.ok) await fail(res)
  return res.json()
}

// —— health / models ——

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) })
    return res.ok
  } catch {
    return false
  }
}

export async function listModels(): Promise<ModelInfo[]> {
  const json = await getJSON<{ data: ModelInfo[] }>('/v1/models')
  return json.data ?? []
}

// —— engine power management (/v1/omni/sleep · /v1/omni/wakeup) ——
// Offload / reload pipeline stages to free or restore GPU memory. `acks`
// carries a per-stage result — an ack with supported:false means that stage's
// backend can't sleep (e.g. some NPU workers), even though status is SUCCESS.

export interface OmniAck {
  supported?: boolean
  error?: string
  [k: string]: unknown
}

export interface OmniPowerResponse {
  status: string // "SUCCESS" | "SKIPPED" | ...
  reason?: string
  acks?: OmniAck[]
}

export function omniSleep(stageIds: number[], level: number) {
  return postJSON<OmniPowerResponse>('/v1/omni/sleep', { stage_ids: stageIds, level })
}

export function omniWakeup(stageIds: number[]) {
  return postJSON<OmniPowerResponse>('/v1/omni/wakeup', { stage_ids: stageIds })
}

// —— SSE plumbing (shared by chat & video chat) ——

/**
 * Read an SSE response line by line and hand each `data:` payload to `onPayload`
 * until `[DONE]` or the stream ends. Returns when the stream is exhausted.
 */
async function pumpSSE(
  res: Response,
  onPayload: (payload: string) => void
): Promise<void> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      onPayload(payload)
    }
  }
}

// —— chat (SSE streaming) ——

export interface ChatStreamCallbacks {
  onDelta: (text: string) => void
  /** base64 WAV segment (chunk with modality: "audio") */
  onAudio?: (b64: string) => void
  /** base64 image (chunk with modality: "image") */
  onImage?: (b64: string) => void
  onDone?: () => void
}

export async function chatStream(
  body: {
    model: string
    messages: ChatMessage[]
    temperature?: number
    top_p?: number
    max_tokens?: number
  },
  { onDelta, onAudio, onImage, onDone }: ChatStreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  if (!res.ok || !res.body) await fail(res)
  await pumpSSE(res, (payload) => {
    try {
      const chunk = JSON.parse(payload)
      const delta = chunk.choices?.[0]?.delta?.content
      if (typeof delta !== 'string' || !delta) return
      const modality = chunk.modality ?? 'text'
      if (modality === 'audio') onAudio?.(delta)
      else if (modality === 'image') onImage?.(delta)
      else onDelta(delta)
    } catch {
      /* keep-alive or partial frame */
    }
  })
  onDone?.()
}

// Streaming video chat & TTS live in ./streams (they are WebSocket, not SSE).

// —— images ——

export function generateImages(req: ImageGenRequest, signal?: AbortSignal) {
  return postJSON<ImagesResponse>('/v1/images/generations', req, signal)
}

export function editImages(form: FormData, signal?: AbortSignal) {
  return postForm<ImagesResponse>('/v1/images/edits', form, signal)
}

// —— videos ——

export function createVideo(form: FormData, signal?: AbortSignal) {
  return postForm<VideoJob>('/v1/videos', form, signal)
}

export function listVideos() {
  return getJSON<VideoListResponse>('/v1/videos')
}

export function getVideo(id: string) {
  return getJSON<VideoJob>(`/v1/videos/${encodeURIComponent(id)}`)
}

export async function deleteVideo(id: string): Promise<void> {
  const res = await fetch(`${BASE}/v1/videos/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!res.ok) await fail(res)
}

export function videoContentUrl(id: string): string {
  return `${BASE}/v1/videos/${encodeURIComponent(id)}/content`
}

// —— audio ——

export interface UploadedVoice {
  name: string
  created_at?: number
  file_size?: number
  mime_type?: string
  ref_text?: string | null
}

export interface VoicesResponse {
  voices: string[]
  uploaded_voices: UploadedVoice[]
}

export function listVoices() {
  return getJSON<VoicesResponse>('/v1/audio/voices')
}

async function postForAudioBlob(
  path: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Blob> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) await fail(res)
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    // some deployments wrap audio in JSON; surface whatever came back as an error
    throw new Error((await res.text()).slice(0, 600))
  }
  return res.blob()
}

export function speak(
  req: {
    input: string
    model?: string
    voice?: string
    speed?: number
    seed?: number
    instructions?: string
    ref_audio?: string
    ref_text?: string
    response_format?: string
  },
  signal?: AbortSignal
) {
  return postForAudioBlob('/v1/audio/speech', req, signal)
}

// Streaming TTS (/v1/audio/speech/stream) is a WebSocket endpoint — see ./streams.

export function generateAudio(
  req: {
    input: string
    model?: string
    audio_length?: number
    num_inference_steps?: number
    guidance_scale?: number
    seed?: number
    negative_prompt?: string
    response_format?: string
  },
  signal?: AbortSignal
) {
  return postForAudioBlob('/v1/audio/generate', req, signal)
}

export function uploadVoice(form: FormData) {
  return postForm<unknown>('/v1/audio/voices', form)
}

export async function deleteVoice(name: string): Promise<void> {
  const res = await fetch(`${BASE}/v1/audio/voices/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!res.ok) await fail(res)
}

// —— playground local filesystem (recordings, duplex input simulation) ——

export interface FsEntry {
  name: string
  size: number
  mtime: number
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** Save a blob as a file on the playground server's host. Returns the absolute path. */
export async function fsSave(dir: string, name: string, blob: Blob): Promise<string> {
  const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
  const res = await fetch('/playground/fs/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir, name, data }),
  })
  if (!res.ok) await fail(res)
  return (await res.json()).path
}

/** List audio files in a directory on the playground server's host. */
export async function fsList(dir: string): Promise<FsEntry[]> {
  const res = await fetch(`/playground/fs/list?dir=${encodeURIComponent(dir)}`)
  if (!res.ok) await fail(res)
  return (await res.json()).files ?? []
}

/** Read a file from the playground server's host. */
export async function fsRead(path: string): Promise<Blob> {
  const res = await fetch(`/playground/fs/read?path=${encodeURIComponent(path)}`)
  if (!res.ok) await fail(res)
  return res.blob()
}

export interface FsBrowseResult {
  path: string
  parent: string | null
  dirs: string[]
  error?: string
}

/** List subdirectories of a path on the playground server's host (for the dir picker). */
export async function fsBrowse(path?: string): Promise<FsBrowseResult> {
  const q = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await fetch(`/playground/fs/browse${q}`)
  if (!res.ok) await fail(res)
  return res.json()
}

// —— playground server config (absent in `vite dev`, hence the catch) ——

export async function getProxyTarget(): Promise<string | null> {
  try {
    const res = await fetch('/playground/config')
    if (!res.ok) return null
    return (await res.json()).target ?? null
  } catch {
    return null
  }
}

export async function setProxyTarget(target: string): Promise<boolean> {
  try {
    const res = await fetch('/playground/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target }),
    })
    return res.ok
  } catch {
    return false
  }
}
