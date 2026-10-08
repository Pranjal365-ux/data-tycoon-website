import { useEffect, useState } from 'react'

interface AntiCameraOverlayProps {
  email: string
  active: boolean
}

export function AntiCameraOverlay({ email, active }: AntiCameraOverlayProps) {
  const [offset, setOffset] = useState({ x: 0, y: 0 })

  useEffect(() => {
    if (!active) return
    // Move watermark around to prevent OCR and make it harder to crop out
    const interval = setInterval(() => {
      setOffset({
        x: Math.random() * 100,
        y: Math.random() * 100,
      })
    }, 3000)
    return () => clearInterval(interval)
  }, [active])

  if (!active) return null

  return (
    <div className="pointer-events-none fixed inset-0 z-[9999] overflow-hidden mix-blend-difference">
      {/* Moiré pattern generator: High frequency grid that conflicts with camera sensors */}
      <div 
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `
            repeating-linear-gradient(0deg, transparent, transparent 1px, #000 1px, #000 2px),
            repeating-linear-gradient(90deg, transparent, transparent 1px, #000 1px, #000 2px)
          `,
          backgroundSize: '2px 2px'
        }}
      />
      
      {/* Moving Identity Watermark */}
      <div 
        className="absolute w-[200vw] h-[200vw] opacity-10 -rotate-45"
        style={{
          transform: `translate(-25%, -25%) rotate(-45deg) translate(${offset.x}px, ${offset.y}px)`,
          transition: 'transform 3s linear'
        }}
      >
        {Array.from({ length: 40 }).map((_, i) => (
          <div key={i} className="flex whitespace-nowrap mb-12">
            {Array.from({ length: 10 }).map((_, j) => (
              <span key={j} className="text-xl font-bold px-8 text-black dark:text-white">
                {email} — ACADEMYFLOW 
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
