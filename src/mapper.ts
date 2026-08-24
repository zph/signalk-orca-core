export interface PathValue {
  path: string
  value: any
}

export type ValueClass = 'dynamic' | 'static'

export interface SensorMappingOptions {
  enableRouteData: boolean
  routeInactivePolicy: 'suppress' | 'publish-zeroes'
  mapDuplicateSensors: boolean
  publishOrcaExtensions: boolean
  trueWindSpeedReference: 'ground' | 'water' | 'existing'
}

export const DEFAULT_SENSOR_MAPPING_OPTIONS: SensorMappingOptions = {
  enableRouteData: true,
  routeInactivePolicy: 'suppress',
  mapDuplicateSensors: false,
  publishOrcaExtensions: false,
  trueWindSpeedReference: 'existing'
}

export interface MappedPathValue extends PathValue {
  sourceKeys?: string[]
  valueClass?: ValueClass
}

export interface AisDelta {
  context: string
  values: MappedPathValue[]
}

type DebugFn = (msg: string) => void

const AIS_KEY_REGEX = /^ais\.x\.(\d+)\.position\.(.+)$/
const MMSI_REGEX = /^\d{9}$/
const TWO_PI = Math.PI * 2

function mappedValue(
  path: string,
  value: any,
  sourceKeys: string[],
  valueClass: ValueClass = 'dynamic'
): MappedPathValue {
  const result: MappedPathValue = { path, value }
  Object.defineProperties(result, {
    sourceKeys: { value: sourceKeys, enumerable: false },
    valueClass: { value: valueClass, enumerable: false }
  })
  return result
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numberInRange(value: unknown, minimum: number, maximum: number): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && number >= minimum && number <= maximum ? number : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

function aisString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || /^[@\-_. ]+$/.test(normalized)) return undefined
  return normalized.slice(0, maximumLength)
}

function aisAngle(value: unknown): number | undefined {
  const angle = finiteNumber(value)
  return angle !== undefined && angle >= 0 && angle < TWO_PI ? angle : undefined
}

function rfc3339(value: unknown): string | undefined {
  const text = aisString(value, 64)
  if (!text || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    return undefined
  }
  return Number.isNaN(Date.parse(text)) ? undefined : text
}

export function mapAisValues(
  values: Record<string, any>,
  debug?: DebugFn,
  options: Partial<SensorMappingOptions> = {}
): AisDelta[] {
  const mappingOptions = { ...DEFAULT_SENSOR_MAPPING_OPTIONS, ...options }
  const byMmsi = new Map<string, Record<string, any>>()
  for (const key of Object.keys(values)) {
    const m = AIS_KEY_REGEX.exec(key)
    if (!m) continue
    const [, mmsi, field] = m
    let bucket = byMmsi.get(mmsi)
    if (!bucket) {
      bucket = {}
      byMmsi.set(mmsi, bucket)
    }
    bucket[field] = values[key]
  }

  const result: AisDelta[] = []
  for (const [mmsi, f] of byMmsi) {
    if (!MMSI_REGEX.test(mmsi)) {
      if (debug) debug('Dropped AIS target with invalid identity')
      continue
    }

    const pv: MappedPathValue[] = []
    const targetPrefix = `ais.x.${mmsi}.position.`
    const sourceKey = (field: string) => `${targetPrefix}${field}`

    const latitude = numberInRange(f.latitude, -90, 90)
    const longitude = numberInRange(f.longitude, -180, 180)
    if (latitude !== undefined && longitude !== undefined) {
      pv.push(mappedValue(
        'navigation.position',
        { latitude, longitude },
        [sourceKey('latitude'), sourceKey('longitude')]
      ))
    }

    const course = aisAngle(f.COG)
    if (course !== undefined) {
      pv.push(mappedValue('navigation.courseOverGroundTrue', course, [sourceKey('COG')]))
    }

    const speed = nonNegativeNumber(f.SOG)
    if (speed !== undefined) {
      pv.push(mappedValue('navigation.speedOverGround', speed, [sourceKey('SOG')]))
    }

    const heading = aisAngle(f.headingTrue)
    if (heading !== undefined) {
      pv.push(mappedValue('navigation.headingTrue', heading, [sourceKey('headingTrue')]))
    }

    const staticFragment: Record<string, any> = { mmsi }
    const staticKeys: string[] = []
    const name = aisString(f.name, 128)
    if (name !== undefined) {
      staticFragment.name = name
      staticKeys.push(sourceKey('name'))
    }

    const callsign = aisString(f.callsign, 32)
    if (callsign !== undefined) {
      staticFragment.communication = { callsignVhf: callsign }
      staticKeys.push(sourceKey('callsign'))
    }

    const vesselType = typeof f.vesselType === 'string'
      ? aisString(f.vesselType, 32)
      : nonNegativeNumber(f.vesselType)
    const beam = nonNegativeNumber(f.beam)
    const length = nonNegativeNumber(f.length)
    const draft = nonNegativeNumber(f.draft)
    if (vesselType !== undefined || beam !== undefined || length !== undefined || draft !== undefined) {
      const design: Record<string, any> = {}
      if (vesselType !== undefined) {
        design.aisShipType = { id: vesselType }
        staticKeys.push(sourceKey('vesselType'))
      }
      if (beam !== undefined) {
        design.beam = beam
        staticKeys.push(sourceKey('beam'))
      }
      if (length !== undefined) {
        design.length = { overall: length }
        staticKeys.push(sourceKey('length'))
      }
      if (draft !== undefined) {
        design.draft = { current: draft }
        staticKeys.push(sourceKey('draft'))
      }
      staticFragment.design = design
    }

    const destinationName = aisString(f.destination, 128)
    const eta = rfc3339(f.eta)
    if (destinationName !== undefined || eta !== undefined) {
      const destination: Record<string, any> = {}
      if (destinationName !== undefined) {
        destination.commonName = destinationName
        staticKeys.push(sourceKey('destination'))
      }
      if (eta !== undefined) {
        destination.eta = eta
        staticKeys.push(sourceKey('eta'))
      }
      staticFragment.navigation = { destination }
    }

    const fallbackKeys = [...pv.flatMap((value) => value.sourceKeys ?? [])]
    pv.unshift(mappedValue('', staticFragment, staticKeys.length > 0 ? staticKeys : fallbackKeys, 'static'))

    const aisClass = aisString(f.class, 16)
    if (aisClass !== undefined) {
      pv.push(mappedValue('sensors.ais.class', aisClass, [sourceKey('class')], 'static'))
    }
    const transceiverInformation = finiteNumber(f.tranceiverInfo)
    if (mappingOptions.publishOrcaExtensions && transceiverInformation !== undefined) {
      pv.push(mappedValue(
        'sensors.ais.transceiverInformation',
        transceiverInformation,
        [sourceKey('tranceiverInfo')]
      ))
    }

    if (debug) debug(`AIS ${mmsi} → ${pv.length} values`)

    if (pv.length > 1 || Object.keys(staticFragment).length > 1) {
      result.push({
        context: `vessels.urn:mrn:imo:mmsi:${mmsi}`,
        values: pv
      })
    }
  }

  return result
}

export function mapOrcaValues(
  values: Record<string, any>,
  debug?: DebugFn,
  options: Partial<SensorMappingOptions> = {}
): PathValue[] {
  const mappingOptions = { ...DEFAULT_SENSOR_MAPPING_OPTIONS, ...options }
  const result: PathValue[] = []
  const v = (key: string) => values[key]
  const keys = Object.keys(values)

  /** Find the first key matching `prefix.<any segments>.suffix` and return its value */
  function firstMatch(prefix: string, suffix: string): { key: string, value: any } | undefined {
    const pat = `${prefix}.`
    const end = `.${suffix}`
    for (const k of keys) {
      if (k.startsWith(pat) && k.endsWith(end) && k.length > pat.length + end.length) {
        return { key: k, value: values[k] }
      }
    }
    return undefined
  }

  function emit(orcaKeys: string | string[], skPath: string, value: any) {
    if (!validMappedValue(value)) return
    result.push(mappedValue(skPath, value, Array.isArray(orcaKeys) ? orcaKeys : [orcaKeys]))
    if (debug) {
      const from = Array.isArray(orcaKeys) ? orcaKeys.join(' + ') : orcaKeys
      debug(`${from} → ${skPath} = ${JSON.stringify(value)}`)
    }
  }

  function validMappedValue(value: any): boolean {
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value === 'string') return value.length > 0
    if (!value || typeof value !== 'object') return false
    return Object.values(value).every(validMappedValue)
  }

  function nonNegative(key: string): number | undefined {
    return nonNegativeNumber(v(key))
  }

  // --- Navigation (device 254, Orca-processed) ---

  // Position (compound)
  const lat = numberInRange(v('navigation.position.254.latitude'), -90, 90)
  const lon = numberInRange(v('navigation.position.254.longitude'), -180, 180)
  if (lat !== undefined && lon !== undefined) {
    emit(
      ['navigation.position.254.latitude', 'navigation.position.254.longitude'],
      'navigation.position',
      { latitude: lat, longitude: lon }
    )
  }

  // COG / SOG
  if (nonNegative('navigation.cogsog.254.speed') !== undefined) {
    emit('navigation.cogsog.254.speed', 'navigation.speedOverGround', nonNegative('navigation.cogsog.254.speed'))
  }
  if (v('navigation.cogsog.254.course') != null) {
    emit('navigation.cogsog.254.course', 'navigation.courseOverGroundTrue', v('navigation.cogsog.254.course'))
  }

  // Heading (reference=1 means magnetic)
  if (v('navigation.heading.254.heading') != null) {
    emit('navigation.heading.254.heading', 'navigation.headingMagnetic', v('navigation.heading.254.heading'))
  }
  if (v('navigation.heading.254.variation') != null) {
    emit('navigation.heading.254.variation', 'navigation.magneticVariation', v('navigation.heading.254.variation'))
  }

  // Rate of turn
  if (v('navigation.rot.254.rot') != null) {
    emit('navigation.rot.254.rot', 'navigation.rateOfTurn', v('navigation.rot.254.rot'))
  }

  // Datetime
  if (v('navigation.time.254.datetime') != null) {
    emit('navigation.time.254.datetime', 'navigation.datetime', v('navigation.time.254.datetime'))
  }

  // GNSS
  if (v('navigation.gnss.254.satellites') != null) {
    emit('navigation.gnss.254.satellites', 'navigation.gnss.satellites', v('navigation.gnss.254.satellites'))
  }
  if (v('navigation.gnss.254.HDOP') != null) {
    emit('navigation.gnss.254.HDOP', 'navigation.gnss.horizontalDilution', v('navigation.gnss.254.HDOP'))
  }
  if (v('navigation.gnss.254.PDOP') != null) {
    emit('navigation.gnss.254.PDOP', 'navigation.gnss.positionDilution', v('navigation.gnss.254.PDOP'))
  }
  if (v('navigation.gnss.254.altitude') != null) {
    emit('navigation.gnss.254.altitude', 'navigation.gnss.antennaAltitude', v('navigation.gnss.254.altitude'))
  }

  // Cross-track error
  const calculationType = finiteNumber(
    v('navigation.data.254.calculationType') ?? v('navigation.data.254.calculation')
  )
  const calculationKey = v('navigation.data.254.calculationType') !== undefined
    ? 'navigation.data.254.calculationType'
    : 'navigation.data.254.calculation'
  const courseFamily = calculationType === 0
    ? 'navigation.courseGreatCircle'
    : calculationType === 1
      ? 'navigation.courseRhumbline'
      : calculationType === undefined
        ? 'navigation.courseRhumbline'
        : undefined
  if (v('navigation.xte.254.xte') != null && courseFamily) {
    emit(
      calculationType === undefined
        ? 'navigation.xte.254.xte'
        : ['navigation.xte.254.xte', calculationKey],
      `${courseFamily}.crossTrackError`,
      v('navigation.xte.254.xte')
    )
  }

  // Active route and next waypoint. A fully zero-filled snapshot is Orca's inactive state.
  const routeFields = [
    'latitude', 'longitude', 'distance', 'bearingFromPosition',
    'bearingFromOrigin', 'velocity', 'etaDate', 'etaTime'
  ].map((field) => v(`navigation.data.254.${field}`))
  const routeActive = mappingOptions.routeInactivePolicy === 'publish-zeroes' ||
    routeFields.some((value) => value !== undefined && value !== null && value !== 0 && value !== '')
  if (mappingOptions.enableRouteData && routeActive && courseFamily && calculationType !== undefined) {
    const routePrefix = 'navigation.data.254.'
    const routeLatitude = numberInRange(v(`${routePrefix}latitude`), -90, 90)
    const routeLongitude = numberInRange(v(`${routePrefix}longitude`), -180, 180)
    if (routeLatitude !== undefined && routeLongitude !== undefined) {
      emit(
        [`${routePrefix}latitude`, `${routePrefix}longitude`, calculationKey],
        `${courseFamily}.nextPoint.position`,
        { latitude: routeLatitude, longitude: routeLongitude }
      )
    }
    const distance = nonNegative(`${routePrefix}distance`)
    if (distance !== undefined) {
      emit([`${routePrefix}distance`, calculationKey], `${courseFamily}.nextPoint.distance`, distance)
    }

    const bearingReference = finiteNumber(v(`${routePrefix}bearingReference`))
    const bearingSuffix = bearingReference === 0 ? 'True' : bearingReference === 1 ? 'Magnetic' : undefined
    const bearingFromPosition = finiteNumber(v(`${routePrefix}bearingFromPosition`))
    if (bearingSuffix && bearingFromPosition !== undefined) {
      emit(
        [`${routePrefix}bearingFromPosition`, `${routePrefix}bearingReference`, calculationKey],
        `${courseFamily}.nextPoint.bearing${bearingSuffix}`,
        bearingFromPosition
      )
    }
    const bearingFromOrigin = finiteNumber(v(`${routePrefix}bearingFromOrigin`))
    if (bearingSuffix && bearingFromOrigin !== undefined) {
      emit(
        [`${routePrefix}bearingFromOrigin`, `${routePrefix}bearingReference`, calculationKey],
        `${courseFamily}.bearingTrack${bearingSuffix}`,
        bearingFromOrigin
      )
    }

    const velocity = nonNegative(`${routePrefix}velocity`)
    if (velocity !== undefined) {
      emit([`${routePrefix}velocity`, calculationKey], `${courseFamily}.nextPoint.velocityMadeGood`, velocity)
    }
    const eta = nmeaEta(v(`${routePrefix}etaDate`), v(`${routePrefix}etaTime`))
    if (eta) {
      emit(
        [`${routePrefix}etaDate`, `${routePrefix}etaTime`, calculationKey],
        `${courseFamily}.nextPoint.estimatedTimeOfArrival`,
        eta
      )
    }

    if (mappingOptions.publishOrcaExtensions) {
      for (const field of ['originWaypoint', 'destinationWaypoint']) {
        const identifier = finiteNumber(v(`${routePrefix}${field}`))
        if (identifier !== undefined) {
          emit(`${routePrefix}${field}`, `navigation.orca.${field}`, identifier)
        }
      }
    }
  }

  // --- Attitude (device 254, compound) ---

  const roll = v('environment.attitude.254.roll')
  const pitch = v('environment.attitude.254.pitch')
  const yaw = v('environment.attitude.254.yaw')
  if (roll != null || pitch != null || yaw != null) {
    const attitude: Record<string, number> = {}
    const attitudeKeys: string[] = []
    if (roll != null) {
      attitude.roll = roll
      attitudeKeys.push('environment.attitude.254.roll')
    }
    if (pitch != null) {
      attitude.pitch = pitch
      attitudeKeys.push('environment.attitude.254.pitch')
    }
    if (yaw != null) {
      attitude.yaw = yaw
      attitudeKeys.push('environment.attitude.254.yaw')
    }
    emit(
      attitudeKeys,
      'navigation.attitude',
      attitude
    )
  }

  // --- Wind (device 254, instance determines reference type) ---

  // Instance 2: Apparent wind
  if (nonNegative('environment.wind.254.2.speed') !== undefined) {
    emit('environment.wind.254.2.speed', 'environment.wind.speedApparent', nonNegative('environment.wind.254.2.speed'))
  }
  if (v('environment.wind.254.2.angle') != null) {
    emit('environment.wind.254.2.angle', 'environment.wind.angleApparent', v('environment.wind.254.2.angle'))
  }

  // Instance 0: True wind (ground reference)
  if ((mappingOptions.trueWindSpeedReference === 'ground' ||
       mappingOptions.trueWindSpeedReference === 'existing') &&
      nonNegative('environment.wind.254.0.speed') !== undefined) {
    emit('environment.wind.254.0.speed', 'environment.wind.speedTrue', nonNegative('environment.wind.254.0.speed'))
  }
  if (v('environment.wind.254.0.angle') != null) {
    emit('environment.wind.254.0.angle', 'environment.wind.angleTrueGround', v('environment.wind.254.0.angle'))
  }

  // Instance 3: True wind (boat/water reference)
  if (v('environment.wind.254.3.angle') != null) {
    emit('environment.wind.254.3.angle', 'environment.wind.angleTrueWater', v('environment.wind.254.3.angle'))
  }
  if (mappingOptions.trueWindSpeedReference === 'water' &&
      nonNegative('environment.wind.254.3.speed') !== undefined) {
    emit('environment.wind.254.3.speed', 'environment.wind.speedTrue', nonNegative('environment.wind.254.3.speed'))
  }

  // --- Sensor-only data (no device 254 equivalent) ---

  // Depth (any device)
  const depthBelow = firstMatch('environment.depth', 'belowTransducer')
  if (depthBelow) {
    emit(depthBelow.key, 'environment.depth.belowTransducer', depthBelow.value)
  }
  const depthOffset = firstMatch('environment.depth', 'offset')
  if (depthOffset) {
    emit(depthOffset.key, 'environment.depth.transducerToKeel', depthOffset.value)
  }

  // Water speed (any device)
  const waterSpeed = firstMatch('environment.waterSpeed', 'speed')
  if (waterSpeed) {
    emit(waterSpeed.key, 'navigation.speedThroughWater', waterSpeed.value)
  }

  // Temperature source is scoped to the exact device and instance.
  const temperatureRegex = /^environment\.temperature\.([^.]+)\.([^.]+)\.temperature$/
  for (const key of keys) {
    const match = temperatureRegex.exec(key)
    if (!match) continue
    const [, device, instance] = match
    const sourceKey = `environment.temperature.${device}.${instance}.source`
    const source = finiteNumber(v(sourceKey))
    const temperature = finiteNumber(v(key))
    if (source === undefined || temperature === undefined) continue
    if (source === 0) {
      emit([key, sourceKey], 'environment.water.temperature', temperature)
    } else if (source === 1) {
      emit([key, sourceKey], 'environment.outside.temperature', temperature)
    } else if ([2, 3, 4, 7, 8, 13].includes(source)) {
      emit([key, sourceKey], `environment.inside.${device}_${instance}.temperature`, temperature)
    } else if (mappingOptions.publishOrcaExtensions) {
      emit([key, sourceKey], `environment.orca.temperature.${device}.${instance}`, temperature)
    }
  }

  // Rudder (any device, any instance)
  const rudder = firstMatch('steering.rudder', 'position')
  if (rudder) {
    emit(rudder.key, 'steering.rudderAngle', rudder.value)
  }

  if (mappingOptions.mapDuplicateSensors) {
    const batteryRegex = /^battery\.([^.]+)\.([^.]+)\.(voltage|current|charge|stateOfCharge|timeRemaining)$/
    for (const key of keys) {
      const match = batteryRegex.exec(key)
      if (!match) continue
      const [, device, instance, field] = match
      const value = finiteNumber(v(key))
      if (value === undefined) continue
      const battery = `electrical.batteries.${device}_${instance}`
      const suffix = field === 'charge' || field === 'stateOfCharge'
        ? 'capacity.stateOfCharge'
        : field === 'timeRemaining'
          ? 'capacity.timeRemaining'
          : field
      emit(key, `${battery}.${suffix}`, value)
    }
  }

  return result
}

function nmeaEta(dateValue: unknown, timeValue: unknown): string | undefined {
  let year: number
  let month: number
  let day: number
  if (typeof dateValue === 'number' && Number.isInteger(dateValue) && dateValue >= 0) {
    const date = new Date(dateValue * 86_400_000)
    year = date.getUTCFullYear()
    month = date.getUTCMonth() + 1
    day = date.getUTCDate()
  } else if (typeof dateValue === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue)
    if (!match) return undefined
    year = Number(match[1])
    month = Number(match[2])
    day = Number(match[3])
  } else {
    return undefined
  }

  let seconds: number
  if (typeof timeValue === 'number' && Number.isFinite(timeValue)) {
    seconds = timeValue
  } else if (typeof timeValue === 'string') {
    const match = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(timeValue)
    if (!match) return undefined
    seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
  } else {
    return undefined
  }
  if (seconds < 0 || seconds >= 86_400 || month < 1 || month > 12 || day < 1 || day > 31) return undefined
  const timestamp = Date.UTC(year, month - 1, day) + Math.round(seconds * 1000)
  const result = new Date(timestamp)
  if (result.getUTCFullYear() !== year || result.getUTCMonth() !== month - 1 || result.getUTCDate() !== day) {
    return undefined
  }
  return result.toISOString()
}
