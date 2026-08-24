import { describe, expect, it, vi } from 'vitest'
import pluginFactory from '../src/index'

describe('plugin configuration schema', () => {
  it('exposes all integration settings with migration-safe defaults', () => {
    const app = {
      registerDeltaInputHandler: vi.fn(),
      handleMessage: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      setPluginStatus: vi.fn(),
      setPluginError: vi.fn(),
      savePluginOptions: vi.fn()
    }
    const plugin = pluginFactory(app)
    const properties = plugin.schema.properties

    expect(properties).toMatchObject({
      enableSensors: { default: true },
      emitOnlyChanges: { default: true },
      heartbeatSeconds: { default: 30 },
      sensorMaxAgeSeconds: { default: 10 },
      enableAis: { default: true },
      aisMode: { default: 'supplemental' },
      aisDynamicMaxAgeSeconds: { default: 900 },
      aisStaticMaxAgeSeconds: { default: 86400 },
      aisTargetExpirySeconds: { default: 1800 },
      localAisFreshnessSeconds: { default: 360 },
      localAisSourcePatterns: { default: ['local-ais-sdr.*', 'n2k-*'] },
      enableRouteData: { default: true },
      routeInactivePolicy: { default: 'suppress' },
      mapDuplicateSensors: { default: false },
      publishOrcaExtensions: { default: false },
      trueWindSpeedReference: { default: 'existing' }
    })
  })
})
