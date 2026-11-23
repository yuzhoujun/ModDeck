import { Fragment, type ReactNode } from 'react'

interface ReleaseNotesViewProps {
  markdown: string
  isZh: boolean
}

const ZH_HEADING_RE = /^#{1,4}\s*.*(简体中文|中文|更新摘要|更新内容|更新日志)/i
const EN_HEADING_RE = /^#{1,4}\s*English\b/i
const CHECKSUM_HEADING_RE = /^#{1,4}\s*(Checksums|SHA256|Hashes|Verification)\b/i

function stripChecksumBlocks(lines: string[]): string[] {
  const out: string[] = []
  let skippingChecksums = false
  let checksumLevel = 4

  for (const line of lines) {
    const trimmed = line.trim()
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      if (CHECKSUM_HEADING_RE.test(trimmed)) {
        skippingChecksums = true
        checksumLevel = level
        continue
      }
      if (skippingChecksums && level <= checksumLevel) {
        skippingChecksums = false
      }
    }
    if (!skippingChecksums) {
      out.push(line)
    }
  }
  return out
}

function trimEdgeDividers(lines: string[]): string {
  let start = 0
  let end = lines.length
  while (start < end && (!lines[start].trim() || /^-{3,}$/.test(lines[start].trim()))) {
    start++
  }
  while (end > start && (!lines[end - 1].trim() || /^-{3,}$/.test(lines[end - 1].trim()))) {
    end--
  }
  return lines.slice(start, end).join('\n')
}

export function extractLocalizedReleaseNotes(rawMarkdown: string, isZh: boolean): string {
  const lines = rawMarkdown.replace(/\r\n?/g, '\n').split('\n')
  const zhIdx = lines.findIndex((l) => ZH_HEADING_RE.test(l.trim()))
  const enIdx = lines.findIndex((l) => EN_HEADING_RE.test(l.trim()))

  let scoped: string[]
  if (isZh) {
    if (zhIdx >= 0) {
      const zhLevel = (lines[zhIdx].trim().match(/^(#{1,4})/)?.[1].length) ?? 2
      let endIdx = lines.length
      for (let i = zhIdx + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim()
        const h = trimmed.match(/^(#{1,4})\s+/)
        if (h && h[1].length <= zhLevel && !ZH_HEADING_RE.test(trimmed)) {
          endIdx = i
          break
        }
        if (CHECKSUM_HEADING_RE.test(trimmed)) {
          endIdx = i
          break
        }
      }
      scoped = lines.slice(zhIdx + 1, endIdx)
    } else {
      scoped = stripChecksumBlocks(lines)
    }
  } else if (enIdx >= 0) {
    const enLevel = (lines[enIdx].trim().match(/^(#{1,4})/)?.[1].length) ?? 2
    let endIdx = lines.length
    for (let i = enIdx + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (zhIdx >= 0 && i >= zhIdx) {
        endIdx = i
        break
      }
      if (CHECKSUM_HEADING_RE.test(trimmed)) {
        endIdx = i
        break
      }
      const h = trimmed.match(/^(#{1,4})\s+/)
      if (h && h[1].length <= enLevel && !EN_HEADING_RE.test(trimmed)) {
        endIdx = i
        break
      }
    }
    scoped = lines.slice(enIdx + 1, endIdx)
  } else if (zhIdx > 0) {
    scoped = stripChecksumBlocks(lines.slice(0, zhIdx))
  } else {
    scoped = stripChecksumBlocks(lines)
  }

  const trimmed = trimEdgeDividers(scoped)
  return trimmed || trimEdgeDividers(stripChecksumBlocks(lines))
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let rest = text
  let keyIdx = 0

  while (rest.length > 0) {
    const match = rest.match(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/)
    if (!match || match.index === undefined) {
      nodes.push(<Fragment key={keyIdx++}>{rest}</Fragment>)
      break
    }

    if (match.index > 0) {
      nodes.push(<Fragment key={keyIdx++}>{rest.slice(0, match.index)}</Fragment>)
    }

    const token = match[0]
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={keyIdx++}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={keyIdx++}>{renderInlineMarkdown(token.slice(2, -2))}</strong>)
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/)
      if (linkMatch) {
        const [, label, href] = linkMatch
        nodes.push(
          <a
            key={keyIdx++}
            href={href}
            onClick={(e) => {
              e.preventDefault()
              void window.moddeck.openExternalUrl(href)
            }}
          >
            {label}
          </a>
        )
      } else {
        nodes.push(<Fragment key={keyIdx++}>{token}</Fragment>)
      }
    }

    rest = rest.slice(match.index + token.length)
  }

  return nodes
}

interface BulletNode {
  text: string
  children: string[]
}

export function ReleaseNotesView({ markdown, isZh }: ReleaseNotesViewProps) {
  const normalized = extractLocalizedReleaseNotes(markdown, isZh)
  if (!normalized.trim()) return null

  const lines = normalized.split('\n')
  const blocks: ReactNode[] = []
  let blockKey = 0
  let i = 0

  while (i < lines.length) {
    const raw = lines[i]
    const trimmed = raw.trim()

    if (!trimmed || /^-{3,}$/.test(trimmed)) {
      i++
      continue
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/)
    if (headingMatch) {
      blocks.push(
        <h4 key={blockKey++} className="rn-heading">
          {renderInlineMarkdown(headingMatch[2])}
        </h4>
      )
      i++
      continue
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      blocks.push(
        <div key={blockKey++} className="rn-quote">
          {renderInlineMarkdown(quoteLines.join(' '))}
        </div>
      )
      continue
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: BulletNode[] = []
      while (i < lines.length) {
        const curRaw = lines[i]
        const curTrim = curRaw.trim()
        const indentMatch = curRaw.match(/^(\s*)[-*]\s+(.+)$/)
        if (!indentMatch) break
        const [, spaces, body] = indentMatch
        if (spaces.length >= 2 && items.length > 0) {
          items[items.length - 1].children.push(body)
        } else {
          items.push({ text: body, children: [] })
        }
        if (!curTrim) break
        i++
      }
      blocks.push(
        <ul key={blockKey++} className="rn-list">
          {items.map((item, idx) => (
            <li key={idx}>
              {renderInlineMarkdown(item.text)}
              {item.children.length > 0 ? (
                <ul className="rn-sublist">
                  {item.children.map((sub, subIdx) => (
                    <li key={subIdx}>{renderInlineMarkdown(sub)}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )
      continue
    }

    const paraLines: string[] = []
    while (i < lines.length) {
      const pTrim = lines[i].trim()
      if (!pTrim || /^#{1,4}\s+/.test(pTrim) || pTrim.startsWith('>') || /^[-*]\s+/.test(pTrim) || /^-{3,}$/.test(pTrim)) {
        break
      }
      paraLines.push(pTrim)
      i++
    }
    if (paraLines.length > 0) {
      blocks.push(
        <p key={blockKey++} className="rn-para">
          {renderInlineMarkdown(paraLines.join(' '))}
        </p>
      )
    } else {
      i++
    }
  }

  return <div className="release-notes-box">{blocks}</div>
}
