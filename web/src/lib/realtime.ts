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

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000 // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** PCM16 samples → base64 (little-endian, as the realtime endpoints expect). */
export function pcm16ToBase64(pcm: Int16Array): string {
  return bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
}

/** Decode any browser-readable audio file to mono PCM16 @ targetRate (16 kHz default). */
export async function decodeToPcm16(data: ArrayBuffer, targetRate = INPUT_RATE): Promise<Int16Array> {
  const ctx = new AudioContext()
  try {
    const buf = await ctx.decodeAudioData(data.slice(0))
    const mono = buf.getChannelData(0)
    return floatToPcm16(resample(mono, buf.sampleRate, targetRate))
  } finally {
    ctx.close()
  }
}
export function base64ToPcm16(b64: string): Int16Array {
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

  /** Milliseconds of queued audio not yet played (duplex playback.ack timing). */
  bufferedMs(): number {
    return Math.max(0, (this.nextStart - this.ctx.currentTime) * 1000)
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

// Plays a sequence of standalone base64 WAV segments (each a full RIFF, as the
// omni chat stream emits) gaplessly: decodes each via the browser and schedules
// it back-to-back. Create it inside a user gesture (e.g. the send handler) so
// its AudioContext is allowed to start.
export class WavSegmentPlayer {
  private ctx = new AudioContext()
  private nextStart = 0
  private chain: Promise<void> = Promise.resolve()
  // Lead buffer: start (or re-buffer after an underrun) this far in the future
  // so a slow/bursty next segment doesn't leave a gap after the first one.
  private static readonly LEAD_S = 0.5

  constructor() {
    this.ctx.resume().catch(() => {})
  }

  enqueue(b64: string): void {
    // serialize decode+schedule so segments stay in arrival order
    this.chain = this.chain.then(() => this.play(b64)).catch(() => {})
  }

  private async play(b64: string): Promise<void> {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    let buf: AudioBuffer
    try {
      buf = await this.ctx.decodeAudioData(bytes.buffer)
    } catch {
      return // not a decodable segment — skip
    }
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.ctx.destination)
    const now = this.ctx.currentTime
    // Fresh start or recovering from an underrun (playback caught up): give the
    // pipeline a lead buffer instead of starting exactly at `now`.
    if (this.nextStart < now) this.nextStart = now + WavSegmentPlayer.LEAD_S
    src.start(this.nextStart)
    this.nextStart += buf.duration
  }

  close(): void {
    this.ctx.close()
  }
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

// —— /v1/realtime?duplex=1 full-duplex session ——
//
// Native duplex (MiniCPM-o 4.5): the mic streams continuously, the server
// decides per commit window whether to keep listening or speak, and playback
// is committed back via playback.ack once it has actually played.
//
//   connect:  ws …/v1/realtime?duplex=1&model=…&minicpmo45_native_duplex=1
//   client →: {type:"session.update", session:{…, extra_body:{auto_response, minicpmo45_native_duplex}}}
//             {type:"input_audio_buffer.append", audio, format:"pcm16", sample_rate_hz:16000}  (continuous)
//             {type:"playback.ack", response_id, item_id, played_ms, committed_ms}
//             {type:"session.close"}
//   server →: session.created/updated, response.listen, response.speak,
//             response.audio.delta/done, response.audio_transcript.delta/done,
//             conversation.item.input_audio_transcription.delta/completed,
//             response.done, output_audio_buffer.cleared, playback.acknowledged,
//             session.closed, error

export interface DuplexCallbacks {
  onReady?: () => void
  onEvent?: (type: string) => void // every server event type, for the log
  onSpeakingChange?: (speaking: boolean) => void
  onUserText?: (delta: string) => void
  onUserTextDone?: () => void
  onAssistantText?: (delta: string) => void
  onAssistantTextDone?: () => void
  onAudio?: (b64: string, sampleRate: number) => void
  /** Response audio fully received; totalMs is the decoded duration, for playback.ack. */
  onAudioDone?: (responseId: string | null, totalMs: number) => void
  onPlaybackCleared?: () => void // server truncated/interrupted output
  onError?: (message: string) => void
  onClose?: () => void
}

export class DuplexSession {
  private ws?: WebSocket
  private readyFlag = false
  private currentResponseId: string | null = null
  private responseAudioMs = new Map<string, number>()

  constructor(
    private url: string,
    private opts: { model: string; instructions?: string; refAudio?: string },
    private cb: DuplexCallbacks
  ) {}

  connect(): void {
    this.ws = new WebSocket(this.url)
    this.ws.onopen = () => {
      const session: Record<string, unknown> = {
        model: this.opts.model,
        modalities: ['audio', 'text'],
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        voice: 'default',
        turn_detection: null,
        overlap_policy: 'listen_only',
        playback_commit_policy: 'ack_only',
        extra_body: {
          auto_response: true,
          minicpmo45_native_duplex: true,
          force_listen_count: 0,
        },
      }
      if (this.opts.instructions) session.instructions = this.opts.instructions
      // Reference voice for TTS (data:audio/…;base64,… URL) — required by
      // MiniCPM-o native duplex for audio output.
      if (this.opts.refAudio) session.ref_audio = this.opts.refAudio
      this.send({ type: 'session.update', session })
    }
    this.ws.onmessage = (ev) => this.dispatch(ev.data)
    this.ws.onerror = () => this.cb.onError?.('WebSocket connection error')
    this.ws.onclose = () => this.cb.onClose?.()
  }

  private static responseIdOf(evt: Record<string, unknown>): string | null {
    if (typeof evt.response_id === 'string') return evt.response_id
    const resp = evt.response as { id?: unknown } | undefined
    return typeof resp?.id === 'string' ? resp.id : null
  }

  private dispatch(raw: unknown): void {
    if (typeof raw !== 'string') return
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(raw)
    } catch {
      return
    }
    const type = typeof evt.type === 'string' ? evt.type : 'unknown'
    this.cb.onEvent?.(type)
    const responseId = DuplexSession.responseIdOf(evt)
    switch (type) {
      case 'session.created':
      case 'session.updated':
        if (!this.readyFlag) {
          this.readyFlag = true
          this.cb.onReady?.()
        }
        break
      case 'response.created':
      case 'response.speak':
        if (responseId) this.currentResponseId = responseId
        this.cb.onSpeakingChange?.(true)
        break
      case 'response.listen':
        this.cb.onSpeakingChange?.(false)
        break
      case 'response.audio.delta': {
        if (responseId) this.currentResponseId = responseId
        const delta = (evt.delta ?? evt.audio) as string | undefined
        if (!delta) break
        const rate = typeof evt.sample_rate_hz === 'number' ? evt.sample_rate_hz : DEFAULT_OUTPUT_RATE
        const id = this.currentResponseId
        if (id) {
          const ms = (base64ToPcm16(delta).length / rate) * 1000
          this.responseAudioMs.set(id, (this.responseAudioMs.get(id) ?? 0) + ms)
        }
        this.cb.onSpeakingChange?.(true)
        this.cb.onAudio?.(delta, rate)
        break
      }
      case 'response.audio.done': {
        const id = responseId ?? this.currentResponseId
        this.cb.onAudioDone?.(id, id ? (this.responseAudioMs.get(id) ?? 0) : 0)
        break
      }
      case 'response.audio_transcript.delta':
      case 'response.output_text.delta':
        if (typeof evt.delta === 'string') this.cb.onAssistantText?.(evt.delta)
        break
      case 'response.audio_transcript.done':
      case 'response.done':
        this.cb.onAssistantTextDone?.()
        this.cb.onSpeakingChange?.(false)
        break
      case 'conversation.item.input_audio_transcription.delta':
        if (typeof evt.delta === 'string') this.cb.onUserText?.(evt.delta)
        break
      case 'conversation.item.input_audio_transcription.completed':
        this.cb.onUserTextDone?.()
        break
      case 'output_audio_buffer.cleared':
      case 'conversation.item.truncated':
        this.cb.onPlaybackCleared?.()
        break
      case 'error':
        this.cb.onError?.(String(evt.error ?? evt.code ?? 'duplex error'))
        break
    }
  }

  private send(event: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event))
  }

  appendAudio(b64: string): void {
    this.send({
      type: 'input_audio_buffer.append',
      audio: b64,
      format: 'pcm16',
      sample_rate_hz: INPUT_RATE,
    })
  }

  /** Tell the server how much of a response actually played (ack_only commit). */
  sendPlaybackAck(responseId: string, playedMs: number): void {
    if (playedMs <= 0) return
    const ms = Math.round(playedMs)
    this.send({
      type: 'playback.ack',
      response_id: responseId,
      item_id: `item_${responseId}`,
      played_ms: ms,
      committed_ms: ms,
    })
    this.responseAudioMs.delete(responseId)
  }

  get ready(): boolean {
    return this.readyFlag
  }

  close(): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'session.close' })
      this.ws?.close()
    } catch {
      /* already closing */
    }
    this.ws = undefined
    this.readyFlag = false
    this.currentResponseId = null
    this.responseAudioMs.clear()
  }
}
