// Realtime voice plumbing for the vllm-omni /v1/realtime WebSocket endpoint.
//
// Protocol (from vllm/entrypoints/speech_to_text/realtime + the omni override):
//   server → client on connect:  {type:"session.created", id, created}
//   client → server:             {type:"session.update", model}          (validate)
//                                {type:"input_audio_buffer.commit"}       (start a turn)
//                                {type:"input_audio_buffer.append", audio} (b64 PCM16 @ 16kHz)
//                                {type:"input_audio_buffer.commit", final:true}  (end audio)
//   server → client per turn:    {type:"transcription.delta", delta}      (text)
//                                {type:"response.audio.delta", audio, format, sample_rate_hz}
//                                {type:"transcription.done", text, usage}
//                                {type:"response.audio.done", has_audio}
//                                {type:"error", error, code}
//
// Input audio MUST be PCM16 mono @ 16 kHz. Output audio is PCM16 mono; the
// server reports its rate per chunk (typically 24 kHz).

export const INPUT_RATE = 16000
export const DEFAULT_OUTPUT_RATE = 24000

// —— PCM16 ⇄ base64 ——

function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000 // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function base64ToPcm16(b64: string): Int16Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  // slice to an even byte count so Int16Array construction can't throw
  const usable = bytes.byteLength - (bytes.byteLength % 2)
  return new Int16Array(bytes.buffer, 0, usable / 2)
}

// Linear resample of a Float32 frame from inRate to outRate.
function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input
  const ratio = inRate / outRate
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    out[i] = input[idx] * (1 - frac) + (input[idx + 1] ?? input[idx]) * frac
  }
  return out
}

// —— microphone → base64 PCM16 @ 16 kHz ——

export class MicCapture {
  private ctx?: AudioContext
  private stream?: MediaStream
  private node?: ScriptProcessorNode
  private source?: MediaStreamAudioSourceNode

  /** onChunk receives base64-encoded PCM16 @ 16 kHz; onLevel is 0..1 RMS for a meter. */
  async start(onChunk: (b64: string) => void, onLevel?: (level: number) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    this.ctx = new AudioContext()
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.node = this.ctx.createScriptProcessor(4096, 1, 1)
    this.node.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      if (onLevel) {
        let sum = 0
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
        onLevel(Math.min(1, Math.sqrt(sum / input.length) * 4))
      }
      const pcm = floatToPcm16(resample(input, this.ctx!.sampleRate, INPUT_RATE))
      if (pcm.length) onChunk(bytesToBase64(new Uint8Array(pcm.buffer)))
    }
    this.source.connect(this.node)
    this.node.connect(this.ctx.destination) // required to pump on some browsers
  }

  stop(): void {
    this.node?.disconnect()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.ctx?.close()
    this.node = this.source = this.stream = this.ctx = undefined
  }
}

// —— base64 PCM16 chunks → speakers (gapless) ——

export class PcmPlayer {
  private ctx = new AudioContext()
  private nextStart = 0
  private live = new Set<AudioBufferSourceNode>()
  /** Captured (samples, rate) so a turn can be exported as a WAV blob. */
  private recorded: { pcm: Int16Array; rate: number }[] = []

  enqueue(b64: string, sampleRate = DEFAULT_OUTPUT_RATE): void {
    const pcm = base64ToPcm16(b64)
    if (pcm.length === 0) return
    this.recorded.push({ pcm: pcm.slice(), rate: sampleRate })
    const buf = this.ctx.createBuffer(1, pcm.length, sampleRate)
    const ch = buf.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.ctx.destination)
    const now = this.ctx.currentTime
    this.nextStart = Math.max(this.nextStart, now)
    src.start(this.nextStart)
    this.nextStart += buf.duration
    this.live.add(src)
    src.onended = () => this.live.delete(src)
  }

  /** Cut playback short (e.g. a turn was interrupted). */
  interrupt(): void {
    for (const s of this.live) {
      try {
        s.stop()
      } catch {
        /* already stopped */
      }
    }
    this.live.clear()
    this.nextStart = this.ctx.currentTime
  }

  /** Merge everything played so far into one WAV blob (uses the last chunk's rate). */
  toWav(): Blob | null {
    if (this.recorded.length === 0) return null
    const rate = this.recorded[this.recorded.length - 1].rate
    return buildWav(
      this.recorded.map((r) => r.pcm),
      rate
    )
  }

  close(): void {
    this.interrupt()
    this.ctx.close()
  }
}

// Build a mono 16-bit PCM WAV blob from Int16 chunks at the given sample rate.
function buildWav(chunks: Int16Array[], rate: number): Blob | null {
  const total = chunks.reduce((n, a) => n + a.length, 0)
  if (total === 0) return null
  const buffer = new ArrayBuffer(44 + total * 2)
  const view = new DataView(buffer)
  const tag = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36 + total * 2, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, total * 2, true)
  let off = 44
  for (const pcm of chunks) {
    for (let i = 0; i < pcm.length; i++, off += 2) view.setInt16(off, pcm[i], true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/** One turn's worth of base64 PCM16 audio deltas → a single playable WAV blob. */
export function pcm16ChunksToWav(b64Chunks: string[], rate = DEFAULT_OUTPUT_RATE): Blob | null {
  return buildWav(b64Chunks.map(base64ToPcm16), rate)
}

// —— WebSocket URL ——

export function realtimeUrl(path: string, params: Record<string, string | undefined>): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const url = new URL(`${proto}://${location.host}/api${path}`)
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v)
  return url.toString()
}

// —— /v1/realtime session ——

export interface RealtimeCallbacks {
  onReady?: () => void // session.created + model validated
  onText?: (delta: string) => void
  onAudio?: (b64: string, sampleRate: number) => void
  onTurnDone?: (text: string) => void
  onAudioDone?: () => void
  onError?: (message: string) => void
  onClose?: () => void
}

export class RealtimeSession {
  private ws?: WebSocket
  private validated = false

  constructor(
    private url: string,
    private model: string | undefined,
    private cb: RealtimeCallbacks
  ) {}

  connect(): void {
    this.ws = new WebSocket(this.url)
    this.ws.onmessage = (ev) => this.dispatch(ev.data)
    this.ws.onerror = () => this.cb.onError?.('WebSocket connection error')
    this.ws.onclose = () => this.cb.onClose?.()
  }

  private dispatch(raw: unknown): void {
    if (typeof raw !== 'string') return
    let evt: {
      type?: string
      delta?: string
      text?: string
      audio?: string
      sample_rate_hz?: number
      error?: string
    }
    try {
      evt = JSON.parse(raw)
    } catch {
      return
    }
    switch (evt.type) {
      case 'session.created':
        // validate the model, then arm a turn (commit "start")
        this.send({ type: 'session.update', model: this.model })
        this.validated = true
        this.cb.onReady?.()
        break
      case 'transcription.delta':
        if (evt.delta) this.cb.onText?.(evt.delta)
        break
      case 'response.audio.delta':
        if (evt.audio) this.cb.onAudio?.(evt.audio, evt.sample_rate_hz ?? DEFAULT_OUTPUT_RATE)
        break
      case 'transcription.done':
        this.cb.onTurnDone?.(evt.text ?? '')
        break
      case 'response.audio.done':
        this.cb.onAudioDone?.()
        break
      case 'error':
        this.cb.onError?.(evt.error ?? 'realtime error')
        break
    }
  }

  private send(event: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event))
  }

  /** Begin a turn: tells the server to start consuming audio as it arrives. */
  startTurn(): void {
    if (this.validated) this.send({ type: 'input_audio_buffer.commit' })
  }

  appendAudio(b64: string): void {
    this.send({ type: 'input_audio_buffer.append', audio: b64 })
  }

  /** End the current turn's audio; the server finalizes and replies. */
  endTurn(): void {
    this.send({ type: 'input_audio_buffer.commit', final: true })
  }

  get ready(): boolean {
    return this.validated
  }

  close(): void {
    try {
      this.ws?.close()
    } catch {
      /* already closing */
    }
    this.ws = undefined
  }
}
