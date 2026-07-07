// WebSocket clients for the three vllm-omni streaming endpoints that are NOT
// the /v1/realtime voice session (that one lives in ./realtime):
//
//   /v1/audio/speech/stream  — incremental text in → per-sentence audio out
//   /v1/video/chat/stream    — video frames (+audio) in → text/audio out
//   /v1/realtime/video       — prompt in → generated video (fMP4 chunks) out
//
// Protocols are taken verbatim from vllm_omni/entrypoints/openai/serving_*.py.

import { realtimeUrl } from './realtime'
import { getSettings } from './store'
import { mergeWavSegments } from './audio'

function apiKeyParam(): Record<string, string | undefined> {
  return { api_key: getSettings().apiKey || undefined }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
}

// —— /v1/audio/speech/stream ——
// client → {type:"session.config", ...}, {type:"input.text", text}, {type:"input.done"}
// server → audio.start{format}, audio.chunk{audio_b64,sample_rate} | <binary wav>,
//          audio.done, session.done, error{message}

export interface SpeakStreamCallbacks {
  /** growing WAV blob as sentences arrive — good for progressive playback */
  onAudio?: (full: Blob) => void
  onSentence?: (text: string) => void
  onDone?: (full: Blob | null) => void
  onError?: (message: string) => void
}

export interface SpeakStreamConfig {
  input: string
  model?: string
  voice?: string
  speed?: number
  response_format?: string
}

export function speakStream(cfg: SpeakStreamConfig, cb: SpeakStreamCallbacks): () => void {
  const ws = new WebSocket(realtimeUrl('/v1/audio/speech/stream', apiKeyParam()))
  ws.binaryType = 'arraybuffer'
  // base64 WAV segments (binary frames) merged for progressive playback
  const wavSegs: string[] = []
  // raw PCM (audio.chunk) accumulation, built into a WAV at the end
  const pcmChunks: Uint8Array[] = []
  let pcmRate = 24000
  let curFormat = 'wav'

  const publish = () => {
    if (wavSegs.length) {
      const blob = mergeWavSegments(wavSegs)
      if (blob) cb.onAudio?.(blob)
    }
  }

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: 'session.config',
        model: cfg.model,
        voice: cfg.voice,
        speed: cfg.speed,
        response_format: cfg.response_format ?? 'wav',
      })
    )
    ws.send(JSON.stringify({ type: 'input.text', text: cfg.input }))
    ws.send(JSON.stringify({ type: 'input.done' }))
  }

  ws.onmessage = async (ev) => {
    if (typeof ev.data !== 'string') {
      // binary WAV frame (default, non-PCM mode)
      const b64 = bytesToBase64(new Uint8Array(ev.data as ArrayBuffer))
      wavSegs.push(b64)
      publish()
      return
    }
    let m: {
      type?: string
      format?: string
      sentence_text?: string
      sample_rate?: number
      audio_b64?: string
      message?: string
    }
    try {
      m = JSON.parse(ev.data)
    } catch {
      return
    }
    switch (m.type) {
      case 'audio.start':
        curFormat = m.format ?? 'wav'
        if (m.sample_rate) pcmRate = m.sample_rate
        if (m.sentence_text) cb.onSentence?.(m.sentence_text)
        break
      case 'audio.chunk':
        if (m.audio_b64) {
          if (curFormat === 'pcm') {
            const bin = atob(m.audio_b64)
            const bytes = new Uint8Array(bin.length)
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
            pcmChunks.push(bytes)
          } else {
            wavSegs.push(m.audio_b64)
            publish()
          }
        }
        break
      case 'session.done':
        cb.onDone?.(finalBlob(wavSegs, pcmChunks, pcmRate))
        ws.close()
        break
      case 'error':
        cb.onError?.(m.message ?? 'speech stream error')
        ws.close()
        break
    }
  }
  ws.onerror = () => cb.onError?.('WebSocket connection error')
  ws.onclose = () => {}

  return () => ws.close()
}

function finalBlob(wavSegs: string[], pcmChunks: Uint8Array[], rate: number): Blob | null {
  if (wavSegs.length) return mergeWavSegments(wavSegs)
  if (pcmChunks.length) return pcmToWav(pcmChunks, rate)
  return null
}

function pcmToWav(chunks: Uint8Array[], rate: number): Blob {
  const dataLen = chunks.reduce((n, c) => n + c.length, 0)
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i))
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, dataLen, true)
  return new Blob([header, ...(chunks as BlobPart[])], { type: 'audio/wav' })
}

// —— /v1/video/chat/stream ——
// client → session.config, video.frame{data}, audio.chunk{data}, video.query{text}, video.done
// server → response.start, response.text.delta{delta}, response.text.done{text},
//          response.audio.delta{data,format}, response.audio.done, session.done, error{message}

export interface VideoChatCallbacks {
  onText?: (delta: string) => void
  onAudio?: (b64: string) => void // base64 WAV segment
  onDone?: () => void
  onError?: (message: string) => void
}

/** Open a session, push the given base64 JPEG frames, then query. Returns a closer. */
export function videoChatStream(
  opts: { frames: string[]; text: string; model?: string },
  cb: VideoChatCallbacks
): () => void {
  const ws = new WebSocket(realtimeUrl('/v1/video/chat/stream', apiKeyParam()))
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'session.config', model: opts.model }))
    for (const data of opts.frames) ws.send(JSON.stringify({ type: 'video.frame', data }))
    ws.send(JSON.stringify({ type: 'video.query', text: opts.text }))
    ws.send(JSON.stringify({ type: 'video.done' }))
  }
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return
    let m: { type?: string; delta?: string; data?: string; message?: string }
    try {
      m = JSON.parse(ev.data)
    } catch {
      return
    }
    switch (m.type) {
      case 'response.text.delta':
        if (m.delta) cb.onText?.(m.delta)
        break
      case 'response.audio.delta':
        if (m.data) cb.onAudio?.(m.data)
        break
      case 'session.done':
        cb.onDone?.()
        ws.close()
        break
      case 'error':
        cb.onError?.(m.message ?? 'video chat error')
        ws.close()
        break
    }
  }
  ws.onerror = () => cb.onError?.('WebSocket connection error')
  return () => ws.close()
}

/** Sample `count` evenly-spaced frames from a video File as base64 JPEG. */
export async function sampleVideoFrames(file: File, count = 8): Promise<string[]> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.crossOrigin = 'anonymous'
  try {
    await new Promise<void>((res, rej) => {
      video.onloadedmetadata = () => res()
      video.onerror = () => rej(new Error('cannot read video'))
    })
    const dur = video.duration || 0
    const canvas = document.createElement('canvas')
    const frames: string[] = []
    for (let i = 0; i < count; i++) {
      const t = dur ? (dur * (i + 0.5)) / count : 0
      await new Promise<void>((res) => {
        video.onseeked = () => res()
        video.currentTime = t
      })
      canvas.width = video.videoWidth || 640
      canvas.height = video.videoHeight || 360
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
      const b64 = canvas.toDataURL('image/jpeg', 0.7).split(',')[1]
      if (b64) frames.push(b64)
    }
    return frames
  } finally {
    URL.revokeObjectURL(url)
  }
}

// —— /v1/realtime/video (text → generated video, fMP4 chunks) ——
// client → session.start{model,prompt,format}, session.stop
// server → video.start{...}, <binary fMP4 bytes>, session.done, error{message}

export interface VideoGenCallbacks {
  onChunk?: (bytes: Uint8Array) => void
  onStart?: (info: unknown) => void
  onDone?: () => void
  onError?: (message: string) => void
}

export function generateVideoStream(
  opts: { prompt: string; model?: string; format?: string },
  cb: VideoGenCallbacks
): () => void {
  const ws = new WebSocket(realtimeUrl('/v1/realtime/video', apiKeyParam()))
  ws.binaryType = 'arraybuffer'
  ws.onopen = () =>
    ws.send(
      JSON.stringify({
        type: 'session.start',
        model: opts.model,
        prompt: opts.prompt,
        format: opts.format ?? 'm4s',
      })
    )
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      cb.onChunk?.(new Uint8Array(ev.data as ArrayBuffer))
      return
    }
    let m: { type?: string; message?: string }
    try {
      m = JSON.parse(ev.data)
    } catch {
      return
    }
    switch (m.type) {
      case 'video.start':
        cb.onStart?.(m)
        break
      case 'session.done':
        cb.onDone?.()
        ws.close()
        break
      case 'error':
        cb.onError?.(m.message ?? 'video generation error')
        ws.close()
        break
    }
  }
  ws.onerror = () => cb.onError?.('WebSocket connection error')
  return () => {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'session.stop' }))
    } catch {
      /* ignore */
    }
    ws.close()
  }
}

export { blobToBase64 }
