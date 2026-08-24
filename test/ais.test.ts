import { describe, it, expect, vi } from 'vitest'
import { mapAisValues } from '../src/mapper'
import { handleOrcaMessage, MessageSink } from '../src/handler'

const SAMPLE_AIS_VALUES = {
  'ais.x.259246000.position.class': 'A',
  'ais.x.259246000.position.latitude': 59.273625,
  'ais.x.259246000.position.longitude': 5.484395,
  'ais.x.259246000.position.COG': 0.282700,
  'ais.x.259246000.position.SOG': 0.000000,
  'ais.x.259246000.position.headingTrue': 5.375600,
  'ais.x.259246000.position.tranceiverInfo': 1,
  'ais.x.257656520.position.class': 'A',
  'ais.x.257656520.position.latitude': 58.976747,
  'ais.x.257656520.position.longitude': 5.736305,
  'ais.x.257656520.position.COG': 3.431300,
  'ais.x.257656520.position.SOG': 0.050000,
  'ais.x.257656520.position.tranceiverInfo': 0,
  'ais.x.257656520.position.name': 'HUNDVAAG I',
  'ais.x.257656520.position.callsign': 'LKOT',
  'ais.x.257656520.position.vesselType': 69,
  'ais.x.257656520.position.beam': 5.0,
  'ais.x.257656520.position.draft': 2.5,
  'ais.x.257656520.position.length': 15.0,
  'ais.x.257656520.position.destination': 'STAVANGER',
  'ais.x.257656520.position.eta': '2026-05-02T16:00:00Z',
}

describe('mapAisValues', () => {
  it('produces one delta per MMSI', () => {
    const result = mapAisValues(SAMPLE_AIS_VALUES)
    expect(result).toHaveLength(2)
    const contexts = result.map((d) => d.context).sort()
    expect(contexts).toEqual([
      'vessels.urn:mrn:imo:mmsi:257656520',
      'vessels.urn:mrn:imo:mmsi:259246000',
    ])
  })

  it('maps position, COG, SOG, heading and class for a minimal AIS target', () => {
    const result = mapAisValues({
      'ais.x.259246000.position.latitude': 59.273625,
      'ais.x.259246000.position.longitude': 5.484395,
      'ais.x.259246000.position.COG': 0.2827,
      'ais.x.259246000.position.SOG': 0.0,
      'ais.x.259246000.position.headingTrue': 5.3756,
      'ais.x.259246000.position.class': 'A',
    })
    expect(result).toHaveLength(1)
    const delta = result[0]
    expect(delta.context).toBe('vessels.urn:mrn:imo:mmsi:259246000')
    expect(delta.values).toContainEqual({ path: '', value: { mmsi: '259246000' } })
    expect(delta.values).toContainEqual({
      path: 'navigation.position',
      value: { latitude: 59.273625, longitude: 5.484395 }
    })
    expect(delta.values).toContainEqual({ path: 'navigation.courseOverGroundTrue', value: 0.2827 })
    expect(delta.values).toContainEqual({ path: 'navigation.speedOverGround', value: 0.0 })
    expect(delta.values).toContainEqual({ path: 'navigation.headingTrue', value: 5.3756 })
    expect(delta.values).toContainEqual({ path: 'sensors.ais.class', value: 'A' })
  })

  it('maps full vessel metadata when present', () => {
    const result = mapAisValues({
      'ais.x.257656520.position.latitude': 58.976747,
      'ais.x.257656520.position.longitude': 5.736305,
      'ais.x.257656520.position.name': 'HUNDVAAG I',
      'ais.x.257656520.position.callsign': 'LKOT',
      'ais.x.257656520.position.vesselType': 69,
      'ais.x.257656520.position.beam': 5.0,
      'ais.x.257656520.position.draft': 2.5,
      'ais.x.257656520.position.length': 15.0,
      'ais.x.257656520.position.destination': 'STAVANGER',
      'ais.x.257656520.position.eta': '2026-05-02T16:00:00Z',
    })
    const delta = result[0]
    expect(delta.values[0]).toEqual({
      path: '',
      value: {
        mmsi: '257656520',
        name: 'HUNDVAAG I',
        communication: { callsignVhf: 'LKOT' },
        design: {
          aisShipType: { id: 69 },
          beam: 5.0,
          length: { overall: 15.0 },
          draft: { current: 2.5 },
        },
        navigation: {
          destination: {
            commonName: 'STAVANGER',
            eta: '2026-05-02T16:00:00Z',
          },
        },
      },
    })
    expect(delta.values.some(({ path }) => path === 'communication.callsignVhf')).toBe(false)
  })

  it('omits absent static fields without empty placeholder objects', () => {
    const [delta] = mapAisValues({
      'ais.x.259246000.position.name': ' TEST VESSEL ',
      'ais.x.259246000.position.callsign': '   ',
      'ais.x.259246000.position.destination': '@@@@@',
    })

    expect(delta.values).toEqual([{ path: '', value: { mmsi: '259246000', name: 'TEST VESSEL' } }])
  })

  it('drops invalid identities and malformed fields without losing valid siblings', () => {
    const result = mapAisValues({
      'ais.x.12345.position.name': 'BAD IDENTITY',
      'ais.x.259246000.position.latitude': 91,
      'ais.x.259246000.position.longitude': 5,
      'ais.x.259246000.position.COG': Number.NaN,
      'ais.x.259246000.position.SOG': -1,
      'ais.x.259246000.position.headingTrue': 511,
      'ais.x.259246000.position.name': 'VALID NAME',
      'ais.x.259246000.position.beam': -2,
      'ais.x.259246000.position.eta': 'not-a-date',
      'ais.x.259246000.position.class': 'B',
    })

    expect(result).toHaveLength(1)
    expect(result[0].values).toEqual([
      { path: '', value: { mmsi: '259246000', name: 'VALID NAME' } },
      { path: 'sensors.ais.class', value: 'B' },
    ])
  })

  it('returns empty array when no AIS keys present', () => {
    const result = mapAisValues({
      'navigation.position.254.latitude': 59.9,
      'navigation.position.254.longitude': 10.7,
    })
    expect(result).toEqual([])
  })

  it('skips MMSIs that have only an MMSI but no other useful data', () => {
    const result = mapAisValues({
      'ais.x.999999999.position.tranceiverInfo': 1,
    })
    expect(result).toEqual([])
  })

  it('publishes transceiver information only as an opt-in Orca extension', () => {
    const values = { 'ais.x.999999999.position.tranceiverInfo': 1 }
    expect(mapAisValues(values)).toEqual([])
    expect(mapAisValues(values, undefined, { publishOrcaExtensions: true })[0].values)
      .toContainEqual({ path: 'sensors.ais.transceiverInformation', value: 1 })
  })
})

describe('handleOrcaMessage with AIS', () => {
  it('emits one handleMessage call per AIS vessel', () => {
    const sink = {
      handleMessage: vi.fn(),
      debug: vi.fn(),
    } satisfies MessageSink

    handleOrcaMessage({
      timestamp: '2026-05-02T17:30:57.560Z',
      values: SAMPLE_AIS_VALUES,
    }, sink)

    expect(sink.handleMessage).toHaveBeenCalledTimes(2)
    const contexts = sink.handleMessage.mock.calls.map((c) => c[1].context).sort()
    expect(contexts).toEqual([
      'vessels.urn:mrn:imo:mmsi:257656520',
      'vessels.urn:mrn:imo:mmsi:259246000',
    ])
  })

  it('emits both self-vessel and AIS deltas when both kinds of data are present', () => {
    const sink = {
      handleMessage: vi.fn(),
      debug: vi.fn(),
    } satisfies MessageSink

    handleOrcaMessage({
      timestamp: '2026-05-02T17:30:57.560Z',
      values: {
        'navigation.position.254.latitude': 60.0,
        'navigation.position.254.longitude': 11.0,
        'ais.x.259246000.position.latitude': 59.273625,
        'ais.x.259246000.position.longitude': 5.484395,
      },
    }, sink)

    expect(sink.handleMessage).toHaveBeenCalledTimes(2)
    const contexts = sink.handleMessage.mock.calls.map((c) => c[1].context).sort()
    expect(contexts).toEqual([
      'vessels.self',
      'vessels.urn:mrn:imo:mmsi:259246000',
    ])
  })

  it('preserves the timestamp on AIS deltas', () => {
    const sink = {
      handleMessage: vi.fn(),
      debug: vi.fn(),
    } satisfies MessageSink

    handleOrcaMessage({
      timestamp: '2026-05-02T17:30:57.560Z',
      values: {
        'ais.x.259246000.position.latitude': 59.273625,
        'ais.x.259246000.position.longitude': 5.484395,
      },
    }, sink)

    const delta = sink.handleMessage.mock.calls[0][1]
    expect(delta.updates[0].timestamp).toBe('2026-05-02T17:30:57.560Z')
  })
})
