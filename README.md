# signalk-orca-core

A Signal K server plugin that ingests sensor, route, and supplemental AIS data from an [Orca Core](https://www.orcamarine.com/) over WebSockets.

> This is an independent community plugin. It is not affiliated with, endorsed by, or supported by Orca Marine Systems.

## Highlights

- Auto-discovers Orca Core via mDNS, with a configured-host fallback.
- Reconstructs source timestamps from Orca `values_age` and rejects stale data.
- Suppresses unchanged full snapshots while retaining a configurable heartbeat.
- Adds Orca-only AIS targets without replacing fresh onboard AIS in `supplemental` mode.
- Emits AIS static data as collision-safe root fragments, including VHF callsigns.
- Maps active route/next-waypoint data, processed XTE, ground/water wind, depth offset, and source-aware temperatures.
- Reports aggregate target, overlap, suppression, stale, invalid, and unchanged counters in plugin status.

Orca Core does not expose target-level traffic provenance through the observed WebSocket API. The plugin therefore identifies its source as `signalk-orca-core` / “Orca Core AIS (provenance not supplied by Core)” and never labels individual targets as MarineTraffic.

## Installation

From the Signal K Appstore, search for “signalk-orca-core”. For development:

```bash
npm install
npm run build
npm link

cd ~/.signalk
npm link signalk-orca-core
```

Restart Signal K, then enable the plugin under Server > Plugin Config.

## Configuration

Existing settings are preserved. A legacy `aisInterval` greater than 120 is treated as milliseconds, converted to seconds, and saved.

| Setting | Default | Description |
|---|---:|---|
| `autoDiscover` | `true` | Discover Orca Core with mDNS. |
| `discoveryTimeout` | `30` | Discovery timeout in seconds. |
| `host` | `10.11.12.1` | Fallback host, or primary host when discovery is disabled. |
| `port` | `8089` | Orca Core WebSocket port. |
| `sensorInterval` | `200` | Requested sensor snapshot interval in milliseconds. |
| `enableSensors` | `true` | Enable the non-AIS sensor stream. |
| `emitOnlyChanges` | `true` | Suppress unchanged canonical values. |
| `heartbeatSeconds` | `30` | Re-emit unchanged dynamic data after its source timestamp advances this far. |
| `sensorMaxAgeSeconds` | `10` | Maximum age for real-time own-vessel data. |
| `enableAis` | `true` | Legacy AIS enable switch; `false` forces AIS off. |
| `aisMode` | `supplemental` | `supplemental`, `all`, or `off`. |
| `aisInterval` | `5` | Requested AIS snapshot interval in seconds. |
| `aisDynamicMaxAgeSeconds` | `900` | Maximum age for AIS position, COG, SOG, and heading. |
| `aisStaticMaxAgeSeconds` | `86400` | Maximum age for AIS static fields. |
| `aisTargetExpirySeconds` | `1800` | Stop refreshing targets whose dynamics exceed this age. |
| `localAisFreshnessSeconds` | `360` | How long matching onboard dynamic AIS remains authoritative. |
| `localAisSourcePatterns` | `local-ais-sdr.*`, `n2k-*` | Sources treated as onboard AIS. |
| `enableRouteData` | `true` | Publish valid active-route and next-waypoint values. |
| `routeInactivePolicy` | `suppress` | `suppress` zero-filled inactive routes or `publish-zeroes`. |
| `mapDuplicateSensors` | `false` | Opt into generic duplicate data such as instance-preserving batteries. |
| `trueWindSpeedReference` | `existing` | `existing`, `ground`, or `water`. |
| `publishOrcaExtensions` | `false` | Publish documented non-standard Orca diagnostic paths. |
| `syncPingInterval` | `45` | Sync-stream keepalive interval in seconds. |

Source patterns are case-sensitive globs. `*` matches zero or more characters; every other character is literal. For example, `n2k-*` matches `n2k-onboard.AI`, while `local-ais-sdr.*` matches `local-ais-sdr.AI`.

`supplemental` mode requires Signal K's delta-input inspection API. If that API is unavailable, the plugin explicitly reports the limitation and uses `all`; it does not claim to enforce local precedence. `off` and `enableAis=false` both prevent the AIS WebSocket from opening.

For true wind speed, `ground` selects Orca instance 0, `water` selects instance 3, and `existing` uses instance 0 only when a fresh direct `environment.wind.speedTrue` is not present. The effective choice is included in plugin status.

## Mapped data

Own-vessel mappings include:

| Orca Core | Signal K |
|---|---|
| `navigation.position.254.*` | `navigation.position` |
| `navigation.cogsog.254.*` | `navigation.speedOverGround`, `navigation.courseOverGroundTrue` |
| `navigation.heading.254.*` | `navigation.headingMagnetic`, `navigation.magneticVariation` |
| `navigation.rot.254.rot` | `navigation.rateOfTurn` |
| `navigation.gnss.254.*` | quality, dilution, satellite, and altitude paths |
| `navigation.xte.254.xte` | active great-circle/rhumbline `crossTrackError` |
| `navigation.data.254.*` | active course `nextPoint.*`, bearing track, VMG, and ETA |
| `environment.attitude.254.*` | `navigation.attitude` |
| `environment.wind.254.2.*` | apparent wind |
| `environment.wind.254.0.*` | true-ground wind |
| `environment.wind.254.3.*` | true-water wind |
| `environment.depth.<device>.*` | depth below transducer and transducer-to-keel offset |
| `environment.temperature.<device>.<instance>.*` | water, outside, or instance-preserving inside temperature selected by the matching source enum |
| `battery.<device>.<instance>.*` | instance-preserving batteries when duplicate mapping is enabled |

Inactive zero-filled routes, unsupported calculation enums, unknown temperature sources, and duplicate raw sensor groups are suppressed by default. Numeric NMEA waypoint identifiers are not represented as Signal K resource links.

Route bearing input accepts both Orca's live `bearingRef` spelling and the older
`bearingReference` spelling. The referenced bearing is published directly; when
magnetic variation is available, the plugin also derives and publishes the
complementary true or magnetic value for both next-point bearing and bearing track.

### AIS targets

Targets use `vessels.urn:mrn:imo:mmsi:<MMSI>`. Dynamic paths are `navigation.position`, `navigation.courseOverGroundTrue`, `navigation.speedOverGround`, and `navigation.headingTrue`. Static name, callsign, type, beam, length, draft, destination, and ETA are merged through a root-object fragment so an existing primitive `communication.callsignVhf` cannot trigger the Signal K full-model metadata exception.

`sensors.ais.class` is retained as a documented extension. With Orca extensions enabled, the misspelled input `tranceiverInfo` is exposed as `sensors.ais.transceiverInformation` with metadata describing it as a raw Orca/NMEA enumeration, not source provenance.

## Development

```bash
npm test
npm run build
```

Sanitized fixtures cover the observed 95-field sensor shape, a 63-target AIS snapshot, differing per-field ages, local/Orca overlap, and active/inactive routes. Tests also run the old and new callsign mappings through Signal K's full-model implementation.

## Docker

```bash
npm run build
docker compose up -d
```

The Signal K admin UI is available at `http://localhost:3000`.

## License

MIT License. Copyright (c) 2026 Trond Hindenes.
