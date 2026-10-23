import { useEffect, useRef, useState } from 'react'

export function ScrollTitle({
  text,
  className = '',
  title
}: {
  text: string
  className?: string
  title?: string
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const innerRef = useRef<HTMLSpanElement | null>(null)
  const [overflowPx, setOverflowPx] = useState(0)

  useEffect(() => {
    const measure = () => {
      const wrap = wrapRef.current
      const inner = innerRef.current
      if (!wrap || !inner) return
      const diff = Math.ceil(inner.scrollWidth - wrap.clientWidth)
      setOverflowPx(diff > 4 ? diff : 0)
    }
    measure()
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null
    if (observer && wrapRef.current) observer.observe(wrapRef.current)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [text])

  const durationSec = overflowPx > 0 ? Math.max(4, Math.min(14, overflowPx / 28 + 3.5)) : 0

  return (
    <div
      ref={wrapRef}
      className={`scroll-title-wrap${overflowPx > 0 ? ' is-overflow' : ''}${className ? ` ${className}` : ''}`}
      title={title ?? text}
      style={
        overflowPx > 0
          ? ({
              '--marquee-shift': `-${overflowPx + 12}px`,
              '--marquee-duration': `${durationSec.toFixed(1)}s`
            } as React.CSSProperties)
          : undefined
      }
    >
      <span ref={innerRef} className="scroll-title-inner">
        {text}
      </span>
    </div>
  )
}
