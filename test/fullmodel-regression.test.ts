import { describe, expect, it, vi } from 'vitest'
import { OrcaMessageProcessor } from '../src/handler'

const FullSignalK = require('@signalk/signalk-schema/dist/fullsignalk')
const MMSI = '990000001'
const CONTEXT = `vessels.urn:mrn:imo:mmsi:${MMSI}`
const TIMESTAMP = '2026-08-23T12:00:00.000Z'

function localRootDelta() {
  return {
    context: CONTEXT,
    updates: [{
      timestamp: TIMESTAMP,
      $source: 'local-ais-sdr.AI',
      values: [{
        path: '',
        value: { mmsi: MMSI, communication: { callsignVhf: 'LOCAL' } }
      }]
    }]
  }
}

describe('Signal K full-model AIS regression', () => {
  it('reproduces the primitive callsign collision with the old leaf mapping', () => {
    const model = new FullSignalK()
    model.addDelta(localRootDelta())
    expect(() => model.addDelta({
      context: CONTEXT,
      updates: [{
        timestamp: TIMESTAMP,
        $source: 'signalk-orca-core',
        values: [{ path: 'communication.callsignVhf', value: 'ORCA' }]
      }]
    })).toThrow(/Cannot create property/)
  })

  it('applies the collision-safe Orca delta with value, metadata, and source state', () => {
    const now = Date.parse(TIMESTAMP)
    const processor = new OrcaMessageProcessor({}, () => now)
    const handleMessage = vi.fn()
    processor.handle({
      timestamp: TIMESTAMP,
      values: {
        [`ais.x.${MMSI}.position.callsign`]: 'ORCA',
        [`ais.x.${MMSI}.position.class`]: 'B'
      },
      values_age: {
        [`ais.x.${MMSI}.position.callsign`]: 1000,
        [`ais.x.${MMSI}.position.class`]: 1000
      }
    }, { handleMessage, debug: vi.fn() })

    const mapped = handleMessage.mock.calls[0][1]
    for (const update of mapped.updates) update.$source = 'signalk-orca-core'
    const model = new FullSignalK()
    model.addDelta(localRootDelta())
    expect(() => model.addDelta(mapped)).not.toThrow()

    const vessel = model.retrieve().vessels[`urn:mrn:imo:mmsi:${MMSI}`]
    expect(vessel.communication.callsignVhf).toBe('ORCA')
    expect(vessel.sensors.ais.class.value).toBe('B')
    expect(vessel.sensors.ais.class.$source).toBe('signalk-orca-core')
    expect(vessel.sensors.ais.class.meta.description).toContain('Orca Core')
  })
})
