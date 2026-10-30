import { useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { useI18n } from '../i18n'

const STAGE = 320
const OUTPUT = 800

export function CoverCropper({
  file,
  onCancel,
  onApply
}: {
  file: File
  // i18n hook injected
  onCancel: () => void
  onApply: (dataUrl: string) => void
}) {
  const { t } = useI18n()
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      setImage(img)
      const scale = Math.max(STAGE / img.width, STAGE / img.height)
      const width = img.width * scale
      const height = img.height * scale
      setOffset({ x: (STAGE - width) / 2, y: (STAGE - height) / 2 })
      setZoom(1)
    }
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [file])

  const baseScale = image ? Math.max(STAGE / image.width, STAGE / image.height) : 1
  const scale = baseScale * zoom
  const width = image ? image.width * scale : 0
  const height = image ? image.height * scale : 0

  function clamp(nextX: number, nextY: number) {
    return {
      x: Math.min(0, Math.max(STAGE - width, nextX)),
      y: Math.min(0, Math.max(STAGE - height, nextY))
    }
  }

  function changeZoom(value: number) {
    setZoom(value)
    if (!image) return
    const nextScale = baseScale * value
    const nextWidth = image.width * nextScale
    const nextHeight = image.height * nextScale
    setOffset((current) => ({
      x: Math.min(0, Math.max(STAGE - nextWidth, current.x)),
      y: Math.min(0, Math.max(STAGE - nextHeight, current.y))
    }))
  }

  function apply() {
    if (!image) return
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT
    canvas.height = OUTPUT
    const context = canvas.getContext('2d')
    if (!context) return
    const ratio = OUTPUT / STAGE
    context.fillStyle = '#0b0d12'
    context.fillRect(0, 0, OUTPUT, OUTPUT)
    context.drawImage(
      image,
      offset.x * ratio,
      offset.y * ratio,
      width * ratio,
      height * ratio
    )
    onApply(canvas.toDataURL('image/png'))
  }

  return (
    <Modal
      title={t('cover.title')}
      onClose={onCancel}
      footer={
        <>
          <div className="grow" />
          <button className="btn ghost" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" onClick={apply} disabled={!image}>
            {t('cover.apply')}
          </button>
        </>
      }
    >
      <div
        className="crop-stage"
        onPointerDown={(event) => {
          if (!image) return
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
        }}
        onPointerMove={(event) => {
          if (!drag.current) return
          const next = clamp(
            drag.current.ox + event.clientX - drag.current.x,
            drag.current.oy + event.clientY - drag.current.y
          )
          setOffset(next)
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        {image ? (
          <img
            src={image.src}
            alt=""
            draggable={false}
            style={{
              width,
              height,
              transform: `translate(${offset.x}px, ${offset.y}px)`
            }}
          />
        ) : (
          <span className="muted">{t('cover.reading')}</span>
        )}
        <div className="crop-grid" />
      </div>
      <label className="field">
        <span>{t('cover.zoom')}</span>
        <input
          type="range"
          min="1"
          max="3"
          step="0.01"
          value={zoom}
          onChange={(event) => changeZoom(Number(event.target.value))}
        />
      </label>
      <p className="muted small">{t('cover.hint')}</p>
    </Modal>
  )
}
