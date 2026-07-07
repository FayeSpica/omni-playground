import { useEffect, useRef, useState } from 'react'
import { chatStream } from '../lib/client'
import { mergeWavSegments } from '../lib/audio'
import { fileToDataURL, useSettings } from '../lib/store'
import type { ChatMessage, ChatParams, ContentPart } from '../lib/types'
import { Empty, ErrorBanner, Field, NumInput } from '../components/Field'
import { FileDrop, type PickedFile } from '../components/FileDrop'
import { Markdown } from '../components/Markdown'

interface UiMessage {
  role: 'user' | 'assistant'
  text: string
  images: string[] // data URLs shown as attachments
  audio: string[] // data URLs
  audioOutUrl?: string // merged WAV object URL (assistant audio modality)
  imagesOut?: string[] // data URLs (assistant image modality)
  streaming?: boolean
}

function toApiMessages(history: UiMessage[], system: string): ChatMessage[] {
  const out: ChatMessage[] = []
  if (system.trim()) out.push({ role: 'system', content: system.trim() })
  for (const m of history) {
    if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.text })
      continue
    }
    const parts: ContentPart[] = []
    for (const url of m.images) parts.push({ type: 'image_url', image_url: { url } })
    for (const url of m.audio) {
      const format = url.slice(url.indexOf('/') + 1, url.indexOf(';')) || 'wav'
      parts.push({
        type: 'input_audio',
        input_audio: { data: url.slice(url.indexOf(',') + 1), format },
      })
    }
    if (m.text) parts.push({ type: 'text', text: m.text })
    out.push({ role: 'user', content: parts.length === 1 && m.text ? m.text : parts })
  }
  return out
}

export function ChatPage() {
  const settings = useSettings()
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<PickedFile[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [params, setParams] = useState<ChatParams>({
    temperature: 0.7,
    top_p: 0.9,
    max_tokens: 2048,
    system: '',
  })
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  async function send() {
    const text = input.trim()
    if ((!text && attachments.length === 0) || busy) return
    setError(null)
    setBusy(true)
    setInput('')

    const images: string[] = []
    const audio: string[] = []
    for (const a of attachments) {
      const dataUrl = await fileToDataURL(a.file)
      if (a.file.type.startsWith('audio/')) audio.push(dataUrl)
      else images.push(dataUrl)
    }
    setAttachments([])

    const userMsg: UiMessage = { role: 'user', text, images, audio }
    const history = [...messages, userMsg]
    setMessages([...history, { role: 'assistant', text: '', images: [], audio: [], streaming: true }])

    const ctrl = new AbortController()
    abortRef.current = ctrl
    const audioSegs: string[] = []
    const patchLast = (patch: Partial<UiMessage> | ((last: UiMessage) => Partial<UiMessage>)) =>
      setMessages((cur) => {
        const next = [...cur]
        const last = next[next.length - 1]
        next[next.length - 1] = {
          ...last,
          ...(typeof patch === 'function' ? patch(last) : patch),
        }
        return next
      })
    try {
      await chatStream(
        {
          model: settings.model,
          messages: toApiMessages(history, params.system),
          temperature: params.temperature,
          top_p: params.top_p,
          max_tokens: params.max_tokens,
        },
        {
          onDelta: (delta) => patchLast((last) => ({ text: last.text + delta })),
          onAudio: (b64) => {
            audioSegs.push(b64)
            const blob = mergeWavSegments(audioSegs)
            if (blob) {
              const url = URL.createObjectURL(blob)
              patchLast((last) => {
                if (last.audioOutUrl) URL.revokeObjectURL(last.audioOutUrl)
                return { audioOutUrl: url }
              })
            }
          },
          onImage: (b64) =>
            patchLast((last) => ({
              imagesOut: [...(last.imagesOut ?? []), `data:image/png;base64,${b64}`],
            })),
        },
        ctrl.signal
      )
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(String((e as Error).message ?? e))
    } finally {
      setMessages((cur) => {
        const next = [...cur]
        const last = next[next.length - 1]
        if (last?.streaming) next[next.length - 1] = { ...last, streaming: false }
        return next.filter(
          (m, i) =>
            !(
              i === next.length - 1 &&
              m.role === 'assistant' &&
              !m.text &&
              !m.audioOutUrl &&
              !m.imagesOut?.length
            )
        )
      })
      setBusy(false)
      abortRef.current = null
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  return (
    <div className="chat">
      <div className="chat__main">
        <div className="chat__scroll" ref={scrollRef}>
          {messages.length === 0 && (
            <Empty title="no messages yet">
              Talk to the omni model — attach images or audio clips and stream the reply back.
            </Empty>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg msg--${m.role}`}>
              <div className="msg__who">{m.role === 'user' ? 'you' : settings.model || 'model'}</div>
              {m.images.length > 0 && (
                <div className="msg__atts">
                  {m.images.map((src, j) => (
                    <img key={j} src={src} alt="attachment" />
                  ))}
                </div>
              )}
              {m.audio.length > 0 && (
                <div className="msg__atts">
                  {m.audio.map((src, j) => (
                    <audio key={j} src={src} controls style={{ height: 32 }} />
                  ))}
                </div>
              )}
              <div className={`msg__bubble${m.streaming && !m.text ? ' cursor-blink' : ''}`}>
                {m.role === 'assistant' ? (
                  <>
                    {m.text && (
                      <span className={m.streaming ? 'cursor-blink' : ''}>
                        <Markdown text={m.text} />
                      </span>
                    )}
                    {m.imagesOut?.map((src, j) => (
                      <a key={j} href={src} target="_blank" rel="noreferrer">
                        <img src={src} alt="generated" className="msg__genimg" />
                      </a>
                    ))}
                    {m.audioOutUrl && (
                      <div className="msg__audio">
                        <span className="chip chip--completed">audio</span>
                        <audio src={m.audioOutUrl} controls />
                        <a
                          className="btn btn--sm btn--ghost"
                          href={m.audioOutUrl}
                          download="omni-reply.wav"
                        >
                          ↓
                        </a>
                      </div>
                    )}
                  </>
                ) : (
                  <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="chat__composer">
          <ErrorBanner error={error} />
          {attachments.length > 0 && (
            <FileDrop
              accept="image/*,audio/*"
              multiple
              files={attachments}
              onChange={setAttachments}
              label="attachments"
            />
          )}
          <div className="chat__inputrow">
            <button
              className="btn btn--ghost"
              title="attach image / audio"
              onClick={() => {
                const el = document.createElement('input')
                el.type = 'file'
                el.accept = 'image/*,audio/*'
                el.multiple = true
                el.onchange = () => {
                  const picked = Array.from(el.files ?? []).map((file) => ({
                    file,
                    previewUrl: URL.createObjectURL(file),
                  }))
                  setAttachments((cur) => [...cur, ...picked])
                }
                el.click()
              }}
            >
              ＋
            </button>
            <textarea
              className="textarea"
              style={{ flex: 1 }}
              placeholder="Message… (Enter to send, Shift+Enter for newline)"
              value={input}
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            {busy ? (
              <button className="btn btn--danger" onClick={stop}>
                Stop
              </button>
            ) : (
              <button
                className="btn btn--primary"
                onClick={send}
                disabled={!input.trim() && attachments.length === 0}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>

      <aside className="chat__aside">
        <div className="section-title">sampling</div>
        <Field label="system prompt">
          <textarea
            className="textarea"
            style={{ minHeight: 64 }}
            value={params.system}
            placeholder="(optional)"
            onChange={(e) => setParams({ ...params, system: e.target.value })}
          />
        </Field>
        <Field label="temperature" hint={String(params.temperature)}>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={params.temperature}
            onChange={(e) => setParams({ ...params, temperature: Number(e.target.value) })}
          />
        </Field>
        <Field label="top_p" hint={String(params.top_p)}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={params.top_p}
            onChange={(e) => setParams({ ...params, top_p: Number(e.target.value) })}
          />
        </Field>
        <Field label="max tokens">
          <NumInput
            value={params.max_tokens}
            min={1}
            onChange={(v) => setParams({ ...params, max_tokens: v === '' ? 2048 : v })}
          />
        </Field>
        <button className="btn btn--ghost btn--sm" onClick={() => setMessages([])}>
          Clear conversation
        </button>
      </aside>
    </div>
  )
}
