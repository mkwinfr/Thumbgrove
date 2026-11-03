import { useRef, type WheelEvent } from 'react'
import { useAppStore } from '../../store'
import { Thumb } from './Thumb'

export function Filmstrip() {
  const queue = useAppStore((s) => s.queue)
  const ref = useRef<HTMLDivElement>(null)

  const onWheel = (event: WheelEvent): void => {
    if (ref.current) ref.current.scrollLeft += event.deltaY
  }

  return (
    <section className="card filmstrip" aria-label="Review queue">
      <div className="filmstrip-track" ref={ref} onWheel={onWheel}>
        {queue.map((item) => (
          <Thumb key={item.id} item={item} />
        ))}
      </div>
    </section>
  )
}
