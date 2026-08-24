import { Plugin, ServerAPI } from '@signalk/server-api'
import WebSocket from 'ws'
import { discoverOrcaCore } from './discovery'
import {
  handleOrcaMessage,
  OrcaMessage,
  OrcaMessageProcessor,
  ProcessingOptions,
  DEFAULT_PROCESSING_OPTIONS
} from './handler'

interface OrcaCoreConfig extends ProcessingOptions {
  autoDiscover: boolean
  discoveryTimeout: number
  host: string
  port: number
  sensorInterval: number
  enableSensors: boolean
  enableAis: boolean
  aisInterval: number
  syncPingInterval: number
}

const RECONNECT_DELAY_MS = 5000
const REDISCOVERY_INTERVAL_MS = 30000
const REDISCOVERY_TIMEOUT_MS = 5000

module.exports = (app: ServerAPI): Plugin => {
  const sockets = new Set<WebSocket>()
  const reconnectTimers = new Set<ReturnType<typeof setTimeout>>()
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let rediscoveryTimer: ReturnType<typeof setInterval> | undefined
  let statusTimer: ReturnType<typeof setInterval> | undefined
  let cancelDiscovery: (() => void) | undefined
  let discoveryInProgress = false
  let stopped = false
  let processor: OrcaMessageProcessor | undefined
  let activeConfig: OrcaCoreConfig | undefined
  const connectedStreams = new Set<string>()
  const canTrackLocalAis = typeof (app as any).registerDeltaInputHandler === 'function'

  if (canTrackLocalAis) {
    ;(app as any).registerDeltaInputHandler((delta: any, next: (delta: any) => void) => {
      try {
        processor?.recordExternalDelta(delta)
      } catch (error) {
        app.debug(`[AIS precedence] Failed to inspect delta: ${error}`)
      }
      next(delta)
    })
  }

  function buildSensorUrl(config: OrcaCoreConfig): string {
    return `ws://${config.host}:${config.port}/v1/sensors/full?interval=${config.sensorInterval}&ns=^(?!.*(ais))`
  }

  function buildAisUrl(config: OrcaCoreConfig): string {
    return `ws://${config.host}:${config.port}/v1/sensors/full?interval=${config.aisInterval * 1000}&ns=ais&enableUnknownSources`
  }

  function buildSyncUrl(config: OrcaCoreConfig): string {
    return `ws://${config.host}:${config.port}/v1/sync`
  }

  const sink = { handleMessage: app.handleMessage.bind(app), debug: app.debug.bind(app) }

  function refreshStatus() {
    if (!activeConfig || !processor) return
    const stats = processor.stats
    const connected = [...connectedStreams].sort().join('+') || 'connecting'
    const sensorTime = stats.lastSensorMessage ?? 'never'
    const aisTime = stats.lastAisMessage ?? 'never'
    app.setPluginStatus(
      `Core ${activeConfig.host}:${activeConfig.port} [${connected}] | ` +
      `sensor ${sensorTime} | AIS ${activeConfig.aisMode} ${aisTime} ` +
      `(Orca Core AIS; target provenance unavailable) | ` +
      `targets ${stats.aisTargetCount}, overlap ${stats.onboardOverlapTargets}, ` +
      `local-suppressed ${stats.localAisSuppressed} | ` +
      `dropped stale ${stats.droppedStale}, invalid ${stats.droppedInvalid}, ` +
      `unchanged ${stats.suppressedUnchanged} | ` +
      `limits sensor/${activeConfig.sensorMaxAgeSeconds}s ` +
      `AIS-dyn/${activeConfig.aisDynamicMaxAgeSeconds}s ` +
      `AIS-static/${activeConfig.aisStaticMaxAgeSeconds}s | ` +
      `true-wind ${activeConfig.trueWindSpeedReference}`
    )
  }

  function startStatusUpdates() {
    if (statusTimer) clearInterval(statusTimer)
    refreshStatus()
    statusTimer = setInterval(refreshStatus, 5000)
  }

  function scheduleReconnect(name: string, buildUrl: () => string, config: OrcaCoreConfig, ping: boolean) {
    if (stopped) return
    app.debug(`[${name}] Reconnecting in ${RECONNECT_DELAY_MS}ms`)
    const timer = setTimeout(() => {
      reconnectTimers.delete(timer)
      if (!stopped) connectWebSocket(name, buildUrl, config, ping)
    }, RECONNECT_DELAY_MS)
    reconnectTimers.add(timer)
  }

  function connectWebSocket(
    name: string,
    buildUrl: () => string,
    config: OrcaCoreConfig,
    ping: boolean
  ) {
    const url = buildUrl()
    app.debug(`[${name}] Connecting to ${url}`)
    const ws = new WebSocket(url)
    sockets.add(ws)

    ws.on('open', () => {
      app.debug(`[${name}] Connected`)
      connectedStreams.add(name)
      refreshStatus()

      if (ping) {
        if (pingTimer) clearInterval(pingTimer)
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ cmd: 'ping' }))
          }
        }, config.syncPingInterval * 1000)
      }
    })

    ws.on('message', (raw: WebSocket.Data) => {
      try {
        const data: OrcaMessage = JSON.parse(raw.toString())
        if (processor) {
          handleOrcaMessage(data, sink, processor)
          const receivedAt = new Date().toISOString()
          if (name === 'SENSOR') processor.stats.lastSensorMessage = receivedAt
          if (name === 'AIS') processor.stats.lastAisMessage = receivedAt
        }
      } catch (e) {
        app.debug(`[${name}] Failed to parse message: ${e}`)
      }
    })

    ws.on('close', () => {
      app.debug(`[${name}] Connection closed`)
      connectedStreams.delete(name)
      sockets.delete(ws)
      refreshStatus()
      if (ping && pingTimer) {
        clearInterval(pingTimer)
        pingTimer = undefined
      }
      scheduleReconnect(name, buildUrl, config, ping)
    })

    ws.on('error', (err: Error) => {
      app.error(`[${name}] WebSocket error: ${err.message}`)
      app.setPluginError(`[${name}] ${err.message}`)
    })
  }

  function startRediscovery(config: OrcaCoreConfig) {
    if (rediscoveryTimer) clearInterval(rediscoveryTimer)
    rediscoveryTimer = setInterval(() => {
      if (stopped || discoveryInProgress) return
      if (reconnectTimers.size === 0) return

      app.debug(`[rediscovery] Connection(s) pending reconnect, running mDNS scan`)
      discoveryInProgress = true
      const discovery = discoverOrcaCore(REDISCOVERY_TIMEOUT_MS, app.debug)
      cancelDiscovery = discovery.cancel
      discovery.promise.then((result) => {
        discoveryInProgress = false
        cancelDiscovery = undefined
        if (stopped || !result) return
        if (result.host !== config.host || result.port !== config.port) {
          app.debug(`[rediscovery] Host changed: ${config.host}:${config.port} → ${result.host}:${result.port}`)
          app.setPluginStatus(`Rediscovered Orca Core at ${result.host}`)
          config.host = result.host
          config.port = result.port
          refreshStatus()
        }
      })
    }, REDISCOVERY_INTERVAL_MS)
  }

  const plugin: Plugin = {
    id: 'signalk-orca-core',
    name: 'Orca Core',
    description: 'Ingests data from Orca Core into SignalK',

    start: (settings: any) => {
      stopped = false
      cancelDiscovery = undefined
      connectedStreams.clear()

      let aisInterval = settings.aisInterval ?? 5
      if (aisInterval > 120) {
        const converted = Math.round(aisInterval / 1000)
        app.debug(`[start] Migrating legacy aisInterval ${aisInterval}ms → ${converted}s`)
        aisInterval = converted
        app.savePluginOptions({ ...settings, aisInterval: converted }, (err) => {
          if (err) app.error(`[start] Failed to persist migrated aisInterval: ${err.message}`)
          else app.debug(`[start] Persisted migrated aisInterval=${converted}`)
        })
      }

      const enableAis = settings.enableAis ?? true
      let aisMode = (settings.aisMode ?? DEFAULT_PROCESSING_OPTIONS.aisMode) as ProcessingOptions['aisMode']
      if (!enableAis || aisMode === 'off') aisMode = 'off'
      if (aisMode === 'supplemental' && !canTrackLocalAis) {
        aisMode = 'all'
        app.setPluginError('Supplemental AIS unavailable: Signal K delta input API is missing; using AIS mode all')
      }

      const config: OrcaCoreConfig = {
        ...DEFAULT_PROCESSING_OPTIONS,
        autoDiscover: settings.autoDiscover ?? true,
        discoveryTimeout: settings.discoveryTimeout ?? 30,
        host: settings.host,
        port: settings.port ?? 8089,
        sensorInterval: settings.sensorInterval ?? 200,
        enableSensors: settings.enableSensors ?? true,
        enableAis,
        aisInterval,
        syncPingInterval: settings.syncPingInterval ?? 45,
        emitOnlyChanges: settings.emitOnlyChanges ?? DEFAULT_PROCESSING_OPTIONS.emitOnlyChanges,
        heartbeatSeconds: settings.heartbeatSeconds ?? DEFAULT_PROCESSING_OPTIONS.heartbeatSeconds,
        sensorMaxAgeSeconds: settings.sensorMaxAgeSeconds ?? DEFAULT_PROCESSING_OPTIONS.sensorMaxAgeSeconds,
        aisMode,
        aisDynamicMaxAgeSeconds: settings.aisDynamicMaxAgeSeconds ?? DEFAULT_PROCESSING_OPTIONS.aisDynamicMaxAgeSeconds,
        aisStaticMaxAgeSeconds: settings.aisStaticMaxAgeSeconds ?? DEFAULT_PROCESSING_OPTIONS.aisStaticMaxAgeSeconds,
        aisTargetExpirySeconds: settings.aisTargetExpirySeconds ?? DEFAULT_PROCESSING_OPTIONS.aisTargetExpirySeconds,
        localAisFreshnessSeconds: settings.localAisFreshnessSeconds ?? DEFAULT_PROCESSING_OPTIONS.localAisFreshnessSeconds,
        localAisSourcePatterns: Array.isArray(settings.localAisSourcePatterns)
          ? settings.localAisSourcePatterns
          : DEFAULT_PROCESSING_OPTIONS.localAisSourcePatterns,
        enableRouteData: settings.enableRouteData ?? DEFAULT_PROCESSING_OPTIONS.enableRouteData,
        routeInactivePolicy: settings.routeInactivePolicy ?? DEFAULT_PROCESSING_OPTIONS.routeInactivePolicy,
        mapDuplicateSensors: settings.mapDuplicateSensors ?? DEFAULT_PROCESSING_OPTIONS.mapDuplicateSensors,
        publishOrcaExtensions: settings.publishOrcaExtensions ?? DEFAULT_PROCESSING_OPTIONS.publishOrcaExtensions,
        trueWindSpeedReference: settings.trueWindSpeedReference ?? DEFAULT_PROCESSING_OPTIONS.trueWindSpeedReference
      }
      activeConfig = config
      processor = new OrcaMessageProcessor(config)

      const connect = (cfg: OrcaCoreConfig) => {
        if (cfg.enableSensors) {
          connectWebSocket('SENSOR', () => buildSensorUrl(cfg), cfg, false)
        }
        if (cfg.enableAis && cfg.aisMode !== 'off') {
          connectWebSocket('AIS', () => buildAisUrl(cfg), cfg, false)
        }
        connectWebSocket('SYNC', () => buildSyncUrl(cfg), cfg, true)
        if (cfg.autoDiscover) startRediscovery(cfg)
        startStatusUpdates()
      }

      if (!config.autoDiscover && !config.host) {
        app.setPluginError('Orca Core Host is required when auto-discover is disabled')
        return
      }

      if (config.autoDiscover) {
        app.setPluginStatus('Searching for Orca Core...')
        const discovery = discoverOrcaCore(config.discoveryTimeout * 1000, app.debug)
        cancelDiscovery = discovery.cancel

        discovery.promise.then((result) => {
          if (stopped) return
          cancelDiscovery = undefined

          if (result) {
            app.debug(`[start] Discovered Orca Core via mDNS: ${result.host}:${result.port} (${result.name})`)
            config.host = result.host
            config.port = result.port
            connect(config)
          } else if (config.host) {
            app.debug(`[start] mDNS discovery failed, falling back to configured host: ${config.host}:${config.port}`)
            app.setPluginStatus(`Discovery failed, using fallback ${config.host}`)
            connect(config)
          } else {
            app.error('[start] mDNS discovery failed and no fallback host configured')
            app.setPluginError('Discovery failed and no fallback host configured')
          }
        })
      } else {
        app.debug(`[start] Auto-discover disabled, using configured host: ${config.host}:${config.port}`)
        connect(config)
      }
    },

    stop: () => {
      stopped = true
      processor = undefined
      activeConfig = undefined
      connectedStreams.clear()
      if (cancelDiscovery) {
        cancelDiscovery()
        cancelDiscovery = undefined
      }
      for (const t of reconnectTimers) clearTimeout(t)
      reconnectTimers.clear()
      if (rediscoveryTimer) {
        clearInterval(rediscoveryTimer)
        rediscoveryTimer = undefined
      }
      if (pingTimer) {
        clearInterval(pingTimer)
        pingTimer = undefined
      }
      if (statusTimer) {
        clearInterval(statusTimer)
        statusTimer = undefined
      }
      for (const ws of sockets) {
        ws.close()
      }
      sockets.clear()
    },

    schema: {
      type: 'object',
      properties: {
        autoDiscover: {
          type: 'boolean',
          title: 'Auto-discover Orca Core via mDNS',
          default: true
        },
        discoveryTimeout: {
          type: 'number',
          title: 'Discovery Timeout (seconds)',
          default: 30
        },
        host: {
          type: 'string',
          title: 'Orca Core Host (used as fallback when auto-discover is on, required when off)',
          pattern: '^([a-zA-Z0-9]([a-zA-Z0-9\\-]*[a-zA-Z0-9])?\\.)*[a-zA-Z0-9]([a-zA-Z0-9\\-]*[a-zA-Z0-9])?$',
          default: '10.11.12.1'
        },
        port: {
          type: 'number',
          title: 'Orca Core Port',
          default: 8089
        },
        sensorInterval: {
          type: 'number',
          title: 'Sensor Update Interval (ms)',
          default: 200
        },
        enableSensors: {
          type: 'boolean',
          title: 'Enable non-AIS sensor data',
          default: true
        },
        emitOnlyChanges: {
          type: 'boolean',
          title: 'Suppress unchanged full-snapshot values',
          default: true
        },
        heartbeatSeconds: {
          type: 'number',
          title: 'Unchanged value heartbeat (seconds)',
          default: 30,
          minimum: 0
        },
        sensorMaxAgeSeconds: {
          type: 'number',
          title: 'Maximum real-time sensor age (seconds)',
          default: 10,
          minimum: 0
        },
        enableAis: {
          type: 'boolean',
          title: 'Enable Orca AIS data',
          default: true
        },
        aisMode: {
          type: 'string',
          title: 'AIS mode',
          description: 'Supplemental prefers fresh onboard AIS. All publishes every eligible Orca target. Off disables AIS.',
          enum: ['supplemental', 'all', 'off'],
          default: 'supplemental'
        },
        aisInterval: {
          type: 'number',
          title: 'AIS Update Interval (seconds)',
          default: 5,
          minimum: 1,
          maximum: 120
        },
        aisDynamicMaxAgeSeconds: {
          type: 'number',
          title: 'Maximum AIS dynamic age (seconds)',
          default: 900,
          minimum: 0
        },
        aisStaticMaxAgeSeconds: {
          type: 'number',
          title: 'Maximum AIS static age (seconds)',
          default: 86400,
          minimum: 0
        },
        aisTargetExpirySeconds: {
          type: 'number',
          title: 'AIS target expiry (seconds)',
          default: 1800,
          minimum: 0
        },
        localAisFreshnessSeconds: {
          type: 'number',
          title: 'Onboard AIS freshness (seconds)',
          default: 360,
          minimum: 0
        },
        localAisSourcePatterns: {
          type: 'array',
          title: 'Onboard AIS source patterns',
          description: 'Case-sensitive glob patterns; * matches any number of characters.',
          items: { type: 'string' },
          default: ['local-ais-sdr.*', 'n2k-*']
        },
        enableRouteData: {
          type: 'boolean',
          title: 'Enable active route and next-waypoint data',
          default: true
        },
        routeInactivePolicy: {
          type: 'string',
          title: 'Inactive route policy',
          enum: ['suppress', 'publish-zeroes'],
          default: 'suppress'
        },
        mapDuplicateSensors: {
          type: 'boolean',
          title: 'Map duplicate generic sensors',
          description: 'Allows Orca battery and duplicate processed paths even when direct providers exist.',
          default: false
        },
        trueWindSpeedReference: {
          type: 'string',
          title: 'True wind speed reference',
          enum: ['existing', 'ground', 'water'],
          default: 'existing'
        },
        publishOrcaExtensions: {
          type: 'boolean',
          title: 'Publish non-standard Orca extension paths',
          default: false
        },
        syncPingInterval: {
          type: 'number',
          title: 'Sync Ping Interval (seconds)',
          default: 45
        }
      }
    }
  }

  return plugin
}
