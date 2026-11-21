import { useLayoutEffect, useRef } from 'react'

const supersample = 4

function paintRing(canvas: HTMLCanvasElement, scratch: HTMLCanvasElement, size: number, value: number, color: string, highContrast: boolean) {
  const context = canvas.getContext('2d')
  const source = scratch.getContext('2d')
  if (!context || !source) return

  canvas.width = canvas.height = size
  scratch.width = scratch.height = size * supersample
  const scale = scratch.width / 100
  source.setTransform(scale, 0, 0, scale, 0, 0)

  // Blend the silhouette into the transparent window instead of outlining it with a hairline.
  const edge = source.createRadialGradient(50, 50, 44.5, 50, 50, 49.5)
  const surface = highContrast ? 'Canvas' : '#10141b'
  const rim = highContrast ? 'CanvasText' : '#4c586a'
  edge.addColorStop(0, surface)
  edge.addColorStop(0.25, surface)
  edge.addColorStop(0.46, rim)
  edge.addColorStop(1, 'transparent')
  source.fillStyle = edge
  source.fillRect(0, 0, 100, 100)

  source.lineWidth = 7
  source.strokeStyle = highContrast ? 'GrayText' : '#465366'
  source.beginPath()
  source.arc(50, 50, 42, 0, 2 * Math.PI)
  source.stroke()

  if (value > 0) {
    const start = -Math.PI / 2
    source.strokeStyle = highContrast ? 'Highlight' : color
    source.lineCap = 'round'
    source.beginPath()
    source.arc(50, 50, 42, start, start + 2 * Math.PI * value / 100)
    source.stroke()
  }

  context.imageSmoothingQuality = 'high'
  context.drawImage(scratch, 0, 0, size, size)
}

export default function RingGraphic({ value, color }: { value: number; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const scratch = document.createElement('canvas')
    const contrast = window.matchMedia('(forced-colors: active)')
    const redraw = () => {
      const size = Math.round(canvas.getBoundingClientRect().width * window.devicePixelRatio)
      if (size > 0) paintRing(canvas, scratch, size, value, color, contrast.matches)
    }
    const observer = new ResizeObserver(redraw)
    observer.observe(canvas, { box: 'device-pixel-content-box' })
    contrast.addEventListener('change', redraw)
    redraw()
    return () => {
      observer.disconnect()
      contrast.removeEventListener('change', redraw)
    }
  }, [value, color])

  return <canvas ref={canvasRef} aria-hidden="true" />
}
