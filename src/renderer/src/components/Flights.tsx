import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { useAppStore, type Flight } from '../store'

const FLIGHT_SIZE = 96

function center(id: string): { x: number; y: number } | null {
  const rect = document.getElementById(id)?.getBoundingClientRect()
  return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
}

function FlightImage({ flight }: { flight: Flight }) {
  const finishFlight = useAppStore((s) => s.finishFlight)
  // Measured once, when the flight begins. Later layout changes must not redirect it.
  const [path] = useState(() => {
    const from = center('review-stage')
    const to = center('nav-discord')
    return from && to ? { from, to } : null
  })
  useEffect(() => {
    if (!path) finishFlight(flight.id)
  }, [path, flight.id, finishFlight])
  if (!path) return null
  const offset = FLIGHT_SIZE / 2
  return (
    <motion.img
      src={flight.src}
      alt=""
      className="flight"
      initial={{ x: path.from.x - offset, y: path.from.y - offset, scale: 1.6, opacity: 0.95, rotate: 0 }}
      animate={{ x: path.to.x - offset, y: path.to.y - offset, scale: 0.16, opacity: 0.2, rotate: -8 }}
      transition={{ delay: flight.delay, duration: 0.55, ease: [0.5, 0, 0.2, 1] }}
      onAnimationComplete={() => finishFlight(flight.id)}
    />
  )
}

/** Applied images fly to the Discord icon, showing where they went. */
export function Flights() {
  const flights = useAppStore((s) => s.flights)
  return (
    <div className="flights" aria-hidden="true">
      {flights.map((flight) => (
        <FlightImage key={flight.id} flight={flight} />
      ))}
    </div>
  )
}
