import { describe, expect, it, vi } from 'vitest'
import { MessageSink, OrcaMessageProcessor } from '../src/handler'

function sink() {
  return {
    handleMessage: vi.fn(),
    debug: vi.fn()
  } satisfies MessageSink
}

const MMSI = '259246000'
const CONTEXT = `vessels.urn:mrn:imo:mmsi:${MMSI}`

describe('OrcaMessageProcessor timestamps and suppression', () => {
  it('uses the oldest source timestamp for a compound position', () => {
    const now = Date.parse('2026-08-23T12:00:00Z')
    const processor = new OrcaMessageProcessor({}, () => now)
    const output = sink()
    processor.handle({
      timestamp: '2026-08-23T12:00:00Z',
      values: {
        'navigation.position.254.latitude': 47.1,
        'navigation.position.254.longitude': -122.2
      },
      values_age: {
        'navigation.position.254.latitude': 1500,
        'navigation.position.254.longitude': 500
      }
    }, output)

    expect(output.handleMessage.mock.calls[0][1].updates[0]).toEqual({
      timestamp: '2026-08-23T11:59:58.500Z',
      values: [{ path: 'navigation.position', value: { latitude: 47.1, longitude: -122.2 } }]
    })
  })

  it('suppresses unchanged snapshots until the source heartbeat advances', () => {
    let now = Date.parse('2026-08-23T12:00:00Z')
    const processor = new OrcaMessageProcessor({ heartbeatSeconds: 30 }, () => now)
    const output = sink()
    const send = () => processor.handle({
      timestamp: new Date(now).toISOString(),
      values: { 'navigation.cogsog.254.speed': 3.5 },
      values_age: { 'navigation.cogsog.254.speed': 0 }
    }, output)

    send()
    now += 10_000
    send()
    expect(output.handleMessage).toHaveBeenCalledTimes(1)
    now += 20_000
    send()
    expect(output.handleMessage).toHaveBeenCalledTimes(2)
    expect(processor.stats.suppressedUnchanged).toBe(1)
  })

  it('does not replace a newer same-source value with an older snapshot', () => {
    let now = Date.parse('2026-08-23T12:00:00Z')
    const processor = new OrcaMessageProcessor({}, () => now)
    const output = sink()
    processor.handle({
      timestamp: new Date(now).toISOString(),
      values: { 'navigation.cogsog.254.speed': 3.5 },
      values_age: { 'navigation.cogsog.254.speed': 0 }
    }, output)

    now += 1000
    processor.handle({
      timestamp: new Date(now).toISOString(),
      values: { 'navigation.cogsog.254.speed': 2.5 },
      values_age: { 'navigation.cogsog.254.speed': 5000 }
    }, output)

    expect(output.handleMessage).toHaveBeenCalledTimes(1)
    expect(processor.stats.droppedStale).toBe(1)
  })

  it('rejects stale AIS dynamics while retaining eligible static data', () => {
    const now = Date.parse('2026-08-23T12:00:00Z')
    const processor = new OrcaMessageProcessor({}, () => now)
    const output = sink()
    processor.handle({
      timestamp: new Date(now).toISOString(),
      values: {
        [`ais.x.${MMSI}.position.latitude`]: 47.1,
        [`ais.x.${MMSI}.position.longitude`]: -122.2,
        [`ais.x.${MMSI}.position.name`]: 'SAFE TEST'
      },
      values_age: {
        [`ais.x.${MMSI}.position.latitude`]: 1_000_000,
        [`ais.x.${MMSI}.position.longitude`]: 1_000_000,
        [`ais.x.${MMSI}.position.name`]: 10_000
      }
    }, output)

    const delta = output.handleMessage.mock.calls[0][1]
    expect(delta.context).toBe(CONTEXT)
    expect(delta.updates).toEqual([{
      timestamp: '2026-08-23T11:59:50.000Z',
      values: [{ path: '', value: { mmsi: MMSI, name: 'SAFE TEST' } }]
    }])
    expect(processor.stats.droppedStale).toBeGreaterThan(0)
  })

  it('prefers fresh matching local AIS and falls back after local expiry', () => {
    let now = Date.parse('2026-08-23T12:00:00Z')
    const processor = new OrcaMessageProcessor({}, () => now)
    const output = sink()
    processor.recordExternalDelta({
      context: CONTEXT,
      updates: [{
        timestamp: new Date(now - 100_000).toISOString(),
        $source: 'local-ais-sdr.AI',
        values: [{ path: 'navigation.position', value: { latitude: 1, longitude: 2 } }]
      }]
    })

    const send = () => processor.handle({
      timestamp: new Date(now).toISOString(),
      values: {
        [`ais.x.${MMSI}.position.latitude`]: 47.1,
        [`ais.x.${MMSI}.position.longitude`]: -122.2
      },
      values_age: {
        [`ais.x.${MMSI}.position.latitude`]: 0,
        [`ais.x.${MMSI}.position.longitude`]: 0
      }
    }, output)

    send()
    expect(output.handleMessage).not.toHaveBeenCalled()
    expect(processor.stats.localAisSuppressed).toBe(1)
    expect(processor.stats.onboardOverlapTargets).toBe(1)

    now += 361_000
    send()
    expect(output.handleMessage).toHaveBeenCalledOnce()
    expect(output.handleMessage.mock.calls[0][1].updates.flatMap((update: any) => update.values))
      .toContainEqual({ path: 'navigation.position', value: { latitude: 47.1, longitude: -122.2 } })
  })

  it('matches configured local source globs and lets newer Orca static data fill gaps', () => {
    const now = Date.parse('2026-08-23T12:00:00Z')
    const processor = new OrcaMessageProcessor({}, () => now)
    const output = sink()
    processor.recordExternalDelta({
      context: CONTEXT,
      updates: [{
        timestamp: new Date(now - 60_000).toISOString(),
        $source: 'n2k-boat.AI',
        values: [{ path: '', value: { name: 'LOCAL NAME', communication: { callsignVhf: 'LOCAL' } } }]
      }]
    })
    processor.handle({
      timestamp: new Date(now).toISOString(),
      values: {
        [`ais.x.${MMSI}.position.name`]: 'NEW ORCA NAME',
        [`ais.x.${MMSI}.position.callsign`]: 'OLD'
      },
      values_age: {
        [`ais.x.${MMSI}.position.name`]: 10_000,
        [`ais.x.${MMSI}.position.callsign`]: 120_000
      }
    }, output)

    expect(output.handleMessage.mock.calls[0][1].updates[0].values).toEqual([
      { path: '', value: { mmsi: MMSI, name: 'NEW ORCA NAME' } }
    ])
  })

  it('isolates an invalid compound age from valid sibling fields', () => {
    const now = Date.parse('2026-08-23T12:00:00Z')
    const processor = new OrcaMessageProcessor({}, () => now)
    const output = sink()
    processor.handle({
      timestamp: new Date(now).toISOString(),
      values: {
        [`ais.x.${MMSI}.position.latitude`]: 47.1,
        [`ais.x.${MMSI}.position.longitude`]: -122.2,
        [`ais.x.${MMSI}.position.SOG`]: 2.5
      },
      values_age: {
        [`ais.x.${MMSI}.position.latitude`]: -5000,
        [`ais.x.${MMSI}.position.longitude`]: 0,
        [`ais.x.${MMSI}.position.SOG`]: 1000
      }
    }, output)

    const values = output.handleMessage.mock.calls[0][1].updates.flatMap((update: any) => update.values)
    expect(values).toContainEqual({ path: 'navigation.speedOverGround', value: 2.5 })
    expect(values.some((value: any) => value.path === 'navigation.position')).toBe(false)
    expect(processor.stats.droppedInvalid).toBeGreaterThan(0)
  })
})
