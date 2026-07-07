// Streaming omni chat delivers audio as several standalone base64 WAV segments.
// Merge them into one playable WAV: keep the first segment's fmt chunk, concatenate
// every segment's data payload, rebuild the RIFF framing.

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

interface WavParts {
  fmt: Uint8Array // raw fmt chunk body
  data: Uint8Array // raw data chunk payload
}

function parseWav(bytes: Uint8Array): WavParts | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (off: number) => String.fromCharCode(...bytes.subarray(off, off + 4))
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let fmt: Uint8Array | null = null
  let data: Uint8Array | null = null
  let off = 12
  while (off + 8 <= bytes.length) {
    const id = tag(off)
    const size = view.getUint32(off + 4, true)
    const body = bytes.subarray(off + 8, Math.min(off + 8 + size, bytes.length))
    if (id === 'fmt ') fmt = body
    if (id === 'data') data = body
    off += 8 + size + (size % 2)
  }
  return fmt && data ? { fmt, data } : null
}

export function mergeWavSegments(base64Segments: string[]): Blob | null {
  const parsed = base64Segments
    .map((b64) => {
      try {
        return parseWav(b64ToBytes(b64))
      } catch {
        return null
      }
    })
    .filter((p): p is WavParts => p !== null)
  if (parsed.length === 0) return null

  const fmt = parsed[0].fmt
  const dataLen = parsed.reduce((n, p) => n + p.data.length, 0)
  const header = new ArrayBuffer(12 + 8 + fmt.length + 8)
  const view = new DataView(header)
  const bytes = new Uint8Array(header)
  const writeTag = (off: number, s: string) => {
    for (let i = 0; i < 4; i++) bytes[off + i] = s.charCodeAt(i)
  }
  writeTag(0, 'RIFF')
  view.setUint32(4, 4 + 8 + fmt.length + 8 + dataLen, true)
  writeTag(8, 'WAVE')
  writeTag(12, 'fmt ')
  view.setUint32(16, fmt.length, true)
  bytes.set(fmt, 20)
  writeTag(20 + fmt.length, 'data')
  view.setUint32(24 + fmt.length, dataLen, true)

  return new Blob([header, ...parsed.map((p) => p.data as BlobPart)], { type: 'audio/wav' })
}
