import { describe, it, expect } from 'vitest'
import { mapOrcaValues } from '../src/mapper'

describe('mapOrcaValues', () => {
  it('maps position from lat/lon', () => {
    const result = mapOrcaValues({
      'navigation.position.254.latitude': 59.9,
      'navigation.position.254.longitude': 10.7
    })
    expect(result).toEqual([
      { path: 'navigation.position', value: { latitude: 59.9, longitude: 10.7 } }
    ])
  })

  it('maps speed over ground', () => {
    const result = mapOrcaValues({
      'navigation.cogsog.254.speed': 3.5
    })
    expect(result).toEqual([
      { path: 'navigation.speedOverGround', value: 3.5 }
    ])
  })

  it('maps course over ground', () => {
    const result = mapOrcaValues({
      'navigation.cogsog.254.course': 1.23
    })
    expect(result).toEqual([
      { path: 'navigation.courseOverGroundTrue', value: 1.23 }
    ])
  })

  it('maps heading and variation', () => {
    const result = mapOrcaValues({
      'navigation.heading.254.heading': 2.1,
      'navigation.heading.254.variation': -0.05
    })
    expect(result).toEqual([
      { path: 'navigation.headingMagnetic', value: 2.1 },
      { path: 'navigation.magneticVariation', value: -0.05 }
    ])
  })

  it('maps apparent wind', () => {
    const result = mapOrcaValues({
      'environment.wind.254.2.speed': 7.2,
      'environment.wind.254.2.angle': 0.8
    })
    expect(result).toEqual([
      { path: 'environment.wind.speedApparent', value: 7.2 },
      { path: 'environment.wind.angleApparent', value: 0.8 }
    ])
  })

  it('maps true wind ground reference', () => {
    const result = mapOrcaValues({
      'environment.wind.254.0.speed': 6.0,
      'environment.wind.254.0.angle': 1.1
    })
    expect(result).toEqual([
      { path: 'environment.wind.speedTrue', value: 6.0 },
      { path: 'environment.wind.angleTrueGround', value: 1.1 }
    ])
  })

  it('maps depth below transducer', () => {
    const result = mapOrcaValues({
      'environment.depth.35.belowTransducer': 12.5
    })
    expect(result).toEqual([
      { path: 'environment.depth.belowTransducer', value: 12.5 }
    ])
  })

  it('maps water temperature', () => {
    const result = mapOrcaValues({
      'environment.temperature.35.0.temperature': 288.15,
      'environment.temperature.35.0.source': 0
    })
    expect(result).toEqual([
      { path: 'environment.water.temperature', value: 288.15 }
    ])
  })

  it('maps rudder angle', () => {
    const result = mapOrcaValues({
      'steering.rudder.11.255.position': 0.1
    })
    expect(result).toEqual([
      { path: 'steering.rudderAngle', value: 0.1 }
    ])
  })

  it('maps battery voltage only when duplicate sensors are enabled', () => {
    const result = mapOrcaValues({
      'battery.254.0.voltage': 12.8
    }, undefined, { mapDuplicateSensors: true })
    expect(result).toEqual([
      { path: 'electrical.batteries.254_0.voltage', value: 12.8 }
    ])
  })

  it('maps attitude (roll, pitch, yaw)', () => {
    const result = mapOrcaValues({
      'environment.attitude.254.roll': 0.05,
      'environment.attitude.254.pitch': -0.02,
      'environment.attitude.254.yaw': 1.5
    })
    expect(result).toEqual([
      { path: 'navigation.attitude', value: { roll: 0.05, pitch: -0.02, yaw: 1.5 } }
    ])
  })

  it('returns empty array for unknown keys', () => {
    const result = mapOrcaValues({
      'some.unknown.key': 42
    })
    expect(result).toEqual([])
  })

  it('returns empty array for empty values', () => {
    const result = mapOrcaValues({})
    expect(result).toEqual([])
  })

  it('isolates malformed sensor fields without losing valid siblings', () => {
    const result = mapOrcaValues({
      'environment.depth.10.belowTransducer': -1,
      'environment.depth.20.belowTransducer': 8.2,
      'environment.attitude.254.roll': 'not-a-number',
      'environment.attitude.254.pitch': 0.1,
      'navigation.cogsog.254.speed': Number.NaN,
      'navigation.cogsog.254.course': 1.2,
    })

    expect(result).toContainEqual({ path: 'environment.depth.belowTransducer', value: 8.2 })
    expect(result).toContainEqual({ path: 'navigation.attitude', value: { pitch: 0.1 } })
    expect(result).toContainEqual({ path: 'navigation.courseOverGroundTrue', value: 1.2 })
    expect(result.some(({ path }) => path === 'navigation.speedOverGround')).toBe(false)
  })

  it('handles a full realistic message with multiple sensor values', () => {
    const result = mapOrcaValues({
      'navigation.position.254.latitude': 60.1,
      'navigation.position.254.longitude': 11.2,
      'navigation.cogsog.254.speed': 2.8,
      'navigation.cogsog.254.course': 0.5,
      'environment.wind.254.2.speed': 5.0,
      'environment.depth.35.belowTransducer': 8.3
    })
    expect(result).toHaveLength(5)
    expect(result[0]).toEqual({
      path: 'navigation.position',
      value: { latitude: 60.1, longitude: 11.2 }
    })
  })

  it.each([
    { deviceId: 35, label: 'default device 35' },
    { deviceId: 40, label: 'device 40' },
    { deviceId: 55, label: 'device 55' },
  ])('maps water speed and depth from $label', ({ deviceId }) => {
    const result = mapOrcaValues({
      [`environment.waterSpeed.${deviceId}.speed`]: 5.0,
      [`environment.waterSpeed.${deviceId+5}.speed`]: 999.0,
      [`environment.depth.${deviceId}.belowTransducer`]: 9.0,
      [`environment.depth.${deviceId+5}.belowTransducer`]: 999.0,
    })
    expect(result).toContainEqual({
      path: 'navigation.speedThroughWater',
      value: 5.0
    })
    expect(result).toContainEqual({
      path: 'environment.depth.belowTransducer',
      value: 9.0
    })
  })

  it.each([
    { deviceId: 35, instance: 0, label: 'device 35 instance 0' },
    { deviceId: 42, instance: 1, label: 'device 42 instance 1' },
    { deviceId: 99, instance: 0, label: 'device 99 instance 0' },
  ])('maps water temperature from $label', ({ deviceId, instance }) => {
    const result = mapOrcaValues({
      [`environment.temperature.${deviceId}.${instance}.temperature`]: 288.15,
      [`environment.temperature.${deviceId}.${instance}.source`]: 0,
    })
    expect(result).toContainEqual({
      path: 'environment.water.temperature',
      value: 288.15
    })
  })

  it('maps temperature using the source from the same device and instance', () => {
    const result = mapOrcaValues({
      'environment.temperature.35.0.temperature': 288.15,
      'environment.temperature.35.0.source': 0,
      'environment.temperature.42.1.temperature': 293.15,
      'environment.temperature.42.1.source': 1,
      'environment.temperature.55.2.temperature': 295.15,
      'environment.temperature.55.2.source': 4,
    })

    expect(result).toContainEqual({ path: 'environment.water.temperature', value: 288.15 })
    expect(result).toContainEqual({ path: 'environment.outside.temperature', value: 293.15 })
    expect(result).toContainEqual({ path: 'environment.inside.55_2.temperature', value: 295.15 })
  })

  it('does not guess water temperature when the source is missing or unknown', () => {
    const result = mapOrcaValues({
      'environment.temperature.35.0.temperature': 288.15,
      'environment.temperature.42.1.temperature': 293.15,
      'environment.temperature.42.1.source': 99,
    })
    expect(result).toEqual([])
  })

  it.each([
    { calculationType: 0, family: 'navigation.courseGreatCircle', bearing: 'True', reference: 0 },
    { calculationType: 1, family: 'navigation.courseRhumbline', bearing: 'Magnetic', reference: 1 },
  ])('maps active route data to $family', ({ calculationType, family, bearing, reference }) => {
    const etaDays = Date.UTC(2026, 7, 24) / 86_400_000
    const result = mapOrcaValues({
      'navigation.data.254.calculationType': calculationType,
      'navigation.data.254.bearingReference': reference,
      'navigation.data.254.latitude': 47.5,
      'navigation.data.254.longitude': -122.5,
      'navigation.data.254.distance': 1200,
      'navigation.data.254.bearingFromPosition': 1.2,
      'navigation.data.254.bearingFromOrigin': 1.1,
      'navigation.data.254.velocity': 2.5,
      'navigation.data.254.etaDate': etaDays,
      'navigation.data.254.etaTime': 12 * 3600 + 30 * 60,
      'navigation.xte.254.xte': 4.2,
    })

    expect(result).toContainEqual({
      path: `${family}.nextPoint.position`,
      value: { latitude: 47.5, longitude: -122.5 }
    })
    expect(result).toContainEqual({ path: `${family}.nextPoint.distance`, value: 1200 })
    expect(result).toContainEqual({ path: `${family}.nextPoint.bearing${bearing}`, value: 1.2 })
    expect(result).toContainEqual({ path: `${family}.bearingTrack${bearing}`, value: 1.1 })
    expect(result).toContainEqual({ path: `${family}.nextPoint.velocityMadeGood`, value: 2.5 })
    expect(result).toContainEqual({
      path: `${family}.nextPoint.estimatedTimeOfArrival`,
      value: '2026-08-24T12:30:00.000Z'
    })
    expect(result).toContainEqual({ path: `${family}.crossTrackError`, value: 4.2 })
  })

  it('suppresses inactive zero-filled and unsupported route snapshots', () => {
    const inactive = mapOrcaValues({
      'navigation.data.254.calculationType': 0,
      'navigation.data.254.latitude': 0,
      'navigation.data.254.longitude': 0,
      'navigation.data.254.distance': 0,
      'navigation.data.254.bearingFromPosition': 0,
      'navigation.data.254.bearingFromOrigin': 0,
      'navigation.data.254.velocity': 0,
      'navigation.data.254.etaDate': 0,
      'navigation.data.254.etaTime': 0,
    })
    const unsupported = mapOrcaValues({
      'navigation.data.254.calculationType': 7,
      'navigation.data.254.latitude': 47.5,
      'navigation.data.254.longitude': -122.5,
    })
    expect(inactive).toEqual([])
    expect(unsupported).toEqual([])
  })

  it('selects water-referenced true wind speed when configured', () => {
    const result = mapOrcaValues({
      'environment.wind.254.0.speed': 5,
      'environment.wind.254.3.speed': 6,
    }, undefined, { trueWindSpeedReference: 'water' })
    expect(result).toEqual([{ path: 'environment.wind.speedTrue', value: 6 }])
  })

  it('preserves battery device and instance identities', () => {
    const result = mapOrcaValues({
      'battery.224.0.voltage': 12.8,
      'battery.225.0.voltage': 24.6,
      'battery.225.1.current': -3.2,
      'battery.225.1.stateOfCharge': 0.75,
    }, undefined, { mapDuplicateSensors: true })

    expect(result).toContainEqual({ path: 'electrical.batteries.224_0.voltage', value: 12.8 })
    expect(result).toContainEqual({ path: 'electrical.batteries.225_0.voltage', value: 24.6 })
    expect(result).toContainEqual({ path: 'electrical.batteries.225_1.current', value: -3.2 })
    expect(result).toContainEqual({
      path: 'electrical.batteries.225_1.capacity.stateOfCharge',
      value: 0.75
    })
  })

  it('maps source-qualified atmospheric pressure only when duplicate sensors are enabled', () => {
    const values = {
      'environment.pressure.128.pressure': 101325,
      'environment.pressure.128.source': 0,
    }
    expect(mapOrcaValues(values)).toEqual([])
    expect(mapOrcaValues(values, undefined, { mapDuplicateSensors: true })).toEqual([
      { path: 'environment.outside.pressure', value: 101325 }
    ])
  })

  it.each([
    { deviceId: 11, instance: 255, label: 'device 11 instance 255' },
    { deviceId: 20, instance: 0, label: 'device 20 instance 0' },
    { deviceId: 5, instance: 128, label: 'device 5 instance 128' },
  ])('maps rudder angle from $label', ({ deviceId, instance }) => {
    const result = mapOrcaValues({
      [`steering.rudder.${deviceId}.${instance}.position`]: 0.1,
    })
    expect(result).toContainEqual({
      path: 'steering.rudderAngle',
      value: 0.1
    })
  })
})
