import { useMemo } from 'react'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: true })

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text, { async: false }) as string, [text])
  return <div dangerouslySetInnerHTML={{ __html: html }} />
}
