import { describe, expect, it, vi } from 'vitest'
import { mapOrcaValues } from '../src/mapper'
import { OrcaMessageProcessor } from '../src/handler'
import sensorSnapshot from './fixtures/sensor-snapshot.json'
import aisSnapshot from './fixtures/ais-63-target-snapshot.json'
import overlap from './fixtures/ais-overlap.json'
import activeRoute from './fixtures/route-active.json'
import inactiveRoute from './fixtures/route-inactive.json'

describe('sanitized capture fixtures', () => {
  it('accounts for the observed 95-field sensor snapshot', () => {
    expect(Object.keys(sensorSnapshot.values)).toHaveLength(95)
    const paths = mapOrcaValues(sensorSnapshot.values).map(({ path }) => path)
    expect(paths).toContain('navigation.position')
    expect(paths).toContain('environment.wind.angleTrueGround')
    expect(paths).toContain('environment.depth.transducerToKeel')
    expect(paths).toContain('environment.outside.temperature')
    expect(paths).toContain('navigation.courseGreatCircle.nextPoint.position')
    expect(paths.some((path) => path.startsWith('electrical.batteries.'))).toBe(false)
  })

  it('emits 63 sanitized AIS contexts with per-field source timestamps', () => {
    const now = Date.parse(aisSnapshot.timestamp)
    const processor = new OrcaMessageProcessor({}, () => now)
    const handleMessage = vi.fn()
    processor.handle(aisSnapshot, { handleMessage, debug: vi.fn() })

    expect(handleMessage).toHaveBeenCalledTimes(63)
    const contexts = handleMessage.mock.calls.map((call) => call[1].context)
    expect(new Set(contexts)).toHaveLength(63)
    expect(contexts.every((context) => /^vessels\.urn:mrn:imo:mmsi:9900000\d{2}$/.test(context))).toBe(true)
    const firstTimestamps = handleMessage.mock.calls[0][1].updates.map((update: any) => update.timestamp)
    expect(new Set(firstTimestamps).size).toBeGreaterThan(1)
  })

  it('suppresses overlapping fresh local AIS fields', () => {
    const now = Date.parse(overlap.orca.timestamp)
    const processor = new OrcaMessageProcessor({}, () => now)
    const handleMessage = vi.fn()
    processor.recordExternalDelta(overlap.local)
    processor.handle(overlap.orca, { handleMessage, debug: vi.fn() })

    expect(handleMessage).not.toHaveBeenCalled()
    expect(processor.stats.localAisSuppressed).toBe(3)
    expect(processor.stats.onboardOverlapTargets).toBe(1)
  })

  it('publishes active route paths and suppresses inactive zeroes', () => {
    const active = mapOrcaValues(activeRoute.values)
    const inactive = mapOrcaValues(inactiveRoute.values)
    expect(active.map(({ path }) => path)).toEqual(expect.arrayContaining([
      'navigation.courseRhumbline.nextPoint.position',
      'navigation.courseRhumbline.nextPoint.distance',
      'navigation.courseRhumbline.nextPoint.bearingMagnetic',
      'navigation.courseRhumbline.bearingTrackMagnetic',
      'navigation.courseRhumbline.nextPoint.velocityMadeGood',
      'navigation.courseRhumbline.nextPoint.estimatedTimeOfArrival',
      'navigation.courseRhumbline.crossTrackError'
    ]))
    expect(inactive).toEqual([])
  })
})
