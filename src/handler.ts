import { mapOrcaValues, mapAisValues, MappedPathValue } from './mapper'

export interface OrcaMessage {
  event_type?: string
  context?: string
  timestamp?: string
  devices?: Record<string, string>
  values?: Record<string, any>
  values_age?: Record<string, any>
}

export interface MessageSink {
  handleMessage: (id: string, delta: any) => void
  debug: (msg: string) => void
}

export type AisMode = 'supplemental' | 'all' | 'off'

export interface ProcessingOptions {
  emitOnlyChanges: boolean
  heartbeatSeconds: number
  sensorMaxAgeSeconds: number
  aisMode: AisMode
  aisDynamicMaxAgeSeconds: number
  aisStaticMaxAgeSeconds: number
  aisTargetExpirySeconds: number
  localAisFreshnessSeconds: number
  localAisSourcePatterns: string[]
}

export interface ProcessingStats {
  lastSensorMessage?: string
  lastAisMessage?: string
  aisTargetCount: number
  onboardOverlapTargets: number
  localAisSuppressed: number
  droppedStale: number
  droppedInvalid: number
  suppressedUnchanged: number
}

export const DEFAULT_PROCESSING_OPTIONS: ProcessingOptions = {
  emitOnlyChanges: true,
  heartbeatSeconds: 30,
  sensorMaxAgeSeconds: 10,
  aisMode: 'supplemental',
  aisDynamicMaxAgeSeconds: 900,
  aisStaticMaxAgeSeconds: 86400,
  aisTargetExpirySeconds: 1800,
  localAisFreshnessSeconds: 360,
  localAisSourcePatterns: ['local-ais-sdr.*', 'n2k-*']
}

interface AcceptedValue {
  value: any
  sourceTimestamp: number
  emittedTimestamp: number
}

interface LocalValue {
  timestamp: number
  source: string
}

interface TimedValue {
  path: string
  value: any
  timestamp: number
  valueClass: 'dynamic' | 'static'
}

const CLOCK_SKEW_TOLERANCE_MS = 2000
const AIS_DYNAMIC_PATHS = new Set([
  'navigation.position',
  'navigation.courseOverGroundTrue',
  'navigation.speedOverGround',
  'navigation.headingTrue'
])
const AIS_STATIC_PATHS = new Set([
  'name',
  'communication.callsignVhf',
  'design.aisShipType',
  'design.beam',
  'design.length',
  'design.draft',
  'navigation.destination.commonName',
  'navigation.destination.eta',
  'sensors.ais.class'
])

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function sourceName(update: any): string | undefined {
  if (typeof update?.$source === 'string') return update.$source
  if (typeof update?.source === 'string') return update.source
  if (typeof update?.source?.label === 'string') return update.source.label
  if (typeof update?.source?.src === 'string') return update.source.src
  return undefined
}

function timestampMilliseconds(timestamp: unknown): number | undefined {
  if (typeof timestamp !== 'string') return undefined
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : undefined
}

function canonicalCopy(value: any): any {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function numericTolerance(path: string): number {
  if (/angle|heading|course|bearing/i.test(path)) return 0.0001
  if (path === 'navigation.position') return 0.000001
  if (/speed|velocity/i.test(path)) return 0.01
  if (/voltage|current/i.test(path)) return 0.01
  return 0
}

function valuesEqual(path: string, left: any, right: any): boolean {
  if (typeof left === 'number' && typeof right === 'number') {
    return Math.abs(left - right) <= numericTolerance(path)
  }
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key) => !rightKeys.includes(key))) return false
  return leftKeys.every((key) => valuesEqual(path, left[key], right[key]))
}

function setNested(target: Record<string, any>, path: string, value: any) {
  const parts = path.split('.')
  let cursor = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    cursor = cursor[parts[index]] ??= {}
  }
  cursor[parts[parts.length - 1]] = value
}

function getNested(target: Record<string, any>, path: string): any {
  return path.split('.').reduce((value, part) => value?.[part], target)
}

function flattenTrackedRoot(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  return [...AIS_STATIC_PATHS].filter((path) => getNested(value as Record<string, any>, path) !== undefined)
}

export class OrcaMessageProcessor {
  readonly options: ProcessingOptions
  readonly stats: ProcessingStats = {
    aisTargetCount: 0,
    onboardOverlapTargets: 0,
    localAisSuppressed: 0,
    droppedStale: 0,
    droppedInvalid: 0,
    suppressedUnchanged: 0
  }

  private readonly clock: () => number
  private readonly accepted = new Map<string, AcceptedValue>()
  private readonly localValues = new Map<string, LocalValue>()
  private readonly localTargets = new Set<string>()
  private readonly sourcePatterns: RegExp[]

  constructor(options: Partial<ProcessingOptions> = {}, clock: () => number = Date.now) {
    this.options = { ...DEFAULT_PROCESSING_OPTIONS, ...options }
    this.clock = clock
    this.sourcePatterns = this.options.localAisSourcePatterns.map(globRegex)
  }

  recordExternalDelta(delta: any) {
    const context = typeof delta?.context === 'string' ? delta.context : ''
    if (!context.startsWith('vessels.urn:mrn:imo:mmsi:') || !Array.isArray(delta?.updates)) return

    for (const update of delta.updates) {
      const source = sourceName(update)
      if (!source || source === 'signalk-orca-core' || !this.sourcePatterns.some((pattern) => pattern.test(source))) {
        continue
      }
      const timestamp = timestampMilliseconds(update.timestamp) ?? this.clock()
      if (!Array.isArray(update.values)) continue

      for (const pathValue of update.values) {
        if (!pathValue || typeof pathValue.path !== 'string') continue
        const paths = pathValue.path === ''
          ? flattenTrackedRoot(pathValue.value)
          : [pathValue.path]
        for (const path of paths) {
          if (!AIS_DYNAMIC_PATHS.has(path) && !AIS_STATIC_PATHS.has(path)) continue
          this.localValues.set(`${context}|${path}`, { timestamp, source })
          this.localTargets.add(context)
        }
      }
    }
  }

  handle(data: OrcaMessage, sink: MessageSink) {
    const values = data.values
    if (!values || Object.keys(values).length === 0) return

    const messageTimestamp = timestampMilliseconds(data.timestamp)
    if (messageTimestamp === undefined) {
      this.stats.droppedInvalid += 1
      sink.debug('Dropped Orca message with invalid timestamp')
      return
    }

    const sensorValues = mapOrcaValues(values, sink.debug)
    if (sensorValues.length > 0) {
      this.stats.lastSensorMessage = new Date(this.clock()).toISOString()
      const accepted = this.processValues(
        'vessels.self', sensorValues, data, this.options.sensorMaxAgeSeconds, sink
      )
      this.emit('vessels.self', accepted, sink)
    }

    if (this.options.aisMode === 'off') return
    const aisTargets = mapAisValues(values, sink.debug)
    if (aisTargets.length > 0) {
      this.stats.lastAisMessage = new Date(this.clock()).toISOString()
      this.stats.aisTargetCount = aisTargets.length
      this.stats.onboardOverlapTargets = aisTargets.filter(({ context }) => this.localTargets.has(context)).length
    }

    for (const ais of aisTargets) {
      const dynamicCandidates = ais.values.filter((value) => value.valueClass !== 'static')
      const dynamicTimestamps = dynamicCandidates
        .map((value) => this.sourceTimestamp(data, value.sourceKeys ?? []))
        .filter((timestamp): timestamp is number => timestamp !== undefined)
      if (dynamicTimestamps.length > 0 &&
          this.clock() - Math.max(...dynamicTimestamps) > this.options.aisTargetExpirySeconds * 1000) {
        this.stats.droppedStale += ais.values.length
        continue
      }

      const dynamic = this.processValues(
        ais.context,
        dynamicCandidates,
        data,
        this.options.aisDynamicMaxAgeSeconds,
        sink,
        true
      )
      const staticValues = ais.values.filter((value) => value.valueClass === 'static' && value.path !== '')
      const acceptedStatic = this.processValues(
        ais.context,
        staticValues,
        data,
        this.options.aisStaticMaxAgeSeconds,
        sink,
        true
      )
      const staticRoot = ais.values.find((value) => value.path === '')
      const root = staticRoot
        ? this.processStaticRoot(ais.context, staticRoot, data, dynamic, sink)
        : []
      this.emit(ais.context, [...root, ...dynamic, ...acceptedStatic], sink)
    }
  }

  private processStaticRoot(
    context: string,
    root: MappedPathValue,
    data: OrcaMessage,
    acceptedDynamic: TimedValue[],
    sink: MessageSink
  ): TimedValue[] {
    const fragment: Record<string, any> = { mmsi: root.value.mmsi }
    const timestamps: number[] = []
    const prefix = `ais.x.${root.value.mmsi}.position.`
    const fields: Array<[string, string]> = [
      ['name', 'name'],
      ['communication.callsignVhf', 'callsign'],
      ['design.aisShipType', 'vesselType'],
      ['design.beam', 'beam'],
      ['design.length', 'length'],
      ['design.draft', 'draft'],
      ['navigation.destination.commonName', 'destination'],
      ['navigation.destination.eta', 'eta']
    ]

    for (const [path, field] of fields) {
      const value = getNested(root.value, path)
      if (value === undefined) continue
      const timestamp = this.sourceTimestamp(data, [`${prefix}${field}`])
      if (timestamp === undefined || !this.withinAge(timestamp, this.options.aisStaticMaxAgeSeconds)) continue
      if (this.localWins(context, path, timestamp, true)) continue
      setNested(fragment, path, value)
      timestamps.push(timestamp)
    }

    if (timestamps.length === 0 && acceptedDynamic.length === 0) return []
    const timestamp = timestamps.length > 0
      ? Math.min(...timestamps)
      : Math.min(...acceptedDynamic.map((value) => value.timestamp))
    const accepted = this.acceptValue(context, '', fragment, timestamp, 'static')
    if (!accepted) return []
    if (Object.keys(fragment).length === 1 && acceptedDynamic.length === 0) {
      sink.debug('Suppressed identity-only AIS root fragment')
      return []
    }
    return [accepted]
  }

  private processValues(
    context: string,
    values: MappedPathValue[],
    data: OrcaMessage,
    maximumAgeSeconds: number,
    _sink: MessageSink,
    applyAisPrecedence = false
  ): TimedValue[] {
    const result: TimedValue[] = []
    for (const pathValue of values) {
      const timestamp = this.sourceTimestamp(data, pathValue.sourceKeys ?? [])
      if (timestamp === undefined) continue
      if (!this.withinAge(timestamp, maximumAgeSeconds)) continue
      const valueClass = pathValue.valueClass ?? 'dynamic'
      if (applyAisPrecedence && this.localWins(context, pathValue.path, timestamp, valueClass === 'static')) {
        continue
      }
      const accepted = this.acceptValue(context, pathValue.path, pathValue.value, timestamp, valueClass)
      if (accepted) result.push(accepted)
    }
    return result
  }

  private sourceTimestamp(data: OrcaMessage, sourceKeys: string[]): number | undefined {
    const messageTimestamp = timestampMilliseconds(data.timestamp)
    if (messageTimestamp === undefined) return undefined
    let oldest = messageTimestamp
    for (const key of sourceKeys) {
      const rawAge = data.values_age?.[key]
      if (rawAge === undefined || rawAge === null ||
          (typeof rawAge !== 'number' || !Number.isFinite(rawAge))) {
        continue
      }
      if (rawAge < -CLOCK_SKEW_TOLERANCE_MS) {
        this.stats.droppedInvalid += 1
        return undefined
      }
      const timestamp = messageTimestamp - Math.max(0, rawAge)
      oldest = Math.min(oldest, timestamp)
    }
    if (oldest > this.clock() + CLOCK_SKEW_TOLERANCE_MS) {
      this.stats.droppedInvalid += 1
      return undefined
    }
    return oldest
  }

  private withinAge(timestamp: number, maximumAgeSeconds: number): boolean {
    if (this.clock() - timestamp <= maximumAgeSeconds * 1000) return true
    this.stats.droppedStale += 1
    return false
  }

  private localWins(context: string, path: string, orcaTimestamp: number, isStatic: boolean): boolean {
    if (this.options.aisMode !== 'supplemental') return false
    const local = this.localValues.get(`${context}|${path}`)
    if (!local) return false
    const localAge = this.clock() - local.timestamp
    const wins = isStatic
      ? local.timestamp >= orcaTimestamp && localAge <= this.options.aisStaticMaxAgeSeconds * 1000
      : localAge <= this.options.localAisFreshnessSeconds * 1000
    if (wins) this.stats.localAisSuppressed += 1
    return wins
  }

  private acceptValue(
    context: string,
    path: string,
    value: any,
    timestamp: number,
    valueClass: 'dynamic' | 'static'
  ): TimedValue | undefined {
    const key = `${context}|${path}`
    const previous = this.accepted.get(key)
    if (previous && timestamp < previous.sourceTimestamp) {
      this.stats.droppedStale += 1
      return undefined
    }

    const changed = !previous || !valuesEqual(path, previous.value, value)
    const heartbeatDue = valueClass !== 'static' && !!previous &&
      timestamp - previous.emittedTimestamp >= this.options.heartbeatSeconds * 1000
    const emit = !this.options.emitOnlyChanges || changed || heartbeatDue
    this.accepted.set(key, {
      value: canonicalCopy(value),
      sourceTimestamp: timestamp,
      emittedTimestamp: emit ? timestamp : previous?.emittedTimestamp ?? timestamp
    })
    if (!emit) {
      this.stats.suppressedUnchanged += 1
      return undefined
    }
    return { path, value, timestamp, valueClass }
  }

  private emit(context: string, values: TimedValue[], sink: MessageSink) {
    if (values.length === 0) return
    const updates = new Map<number, Array<{ path: string, value: any }>>()
    for (const pathValue of values) {
      const bucket = updates.get(pathValue.timestamp) ?? []
      bucket.push({ path: pathValue.path, value: pathValue.value })
      updates.set(pathValue.timestamp, bucket)
    }
    sink.handleMessage('signalk-orca-core', {
      context,
      updates: [...updates.entries()]
        .sort(([left], [right]) => left - right)
        .map(([timestamp, groupedValues]) => ({
          timestamp: new Date(timestamp).toISOString(),
          values: groupedValues
        }))
    })
  }
}

export function handleOrcaMessage(data: OrcaMessage, sink: MessageSink, processor?: OrcaMessageProcessor) {
  const messageTime = timestampMilliseconds(data.timestamp)
  const effectiveProcessor = processor ?? new OrcaMessageProcessor({}, () => messageTime ?? Date.now())
  effectiveProcessor.handle(data, sink)
}
