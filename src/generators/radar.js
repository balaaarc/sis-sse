/**
 * radar.js
 * Covers S01 GPR, S11 MICROWAVE, S13 LIDAR, S17 MMWAVE, S18 GMTI_RADAR.
 *
 * Each modality uses a different raw_value schema (switched by this.modality).
 *
 * GPR (0.1 Hz / 10000ms):
 *   depth_m, scan_distance_m, anomaly_detected, anomaly_confidence,
 *   hyperbola_amplitude, classification, b_scan_row (128 floats)
 *
 * MICROWAVE:
 *   zone_breached, breach_count, zone_id, signal_strength_dbm
 *
 * LIDAR:
 *   point_count, objects_detected, nearest_object_m, point_cloud_summary
 *
 * MMWAVE:
 *   detections: [{range_m, azimuth_deg, velocity_mps, rcs_dbsm}], visibility_m
 *
 * GMTI:
 *   tracks: Track[], range_doppler_map (64 floats), coverage_az_deg, max_range_m
 */

import { v4 as uuidv4 } from 'uuid';
import { BaseGenerator } from './base.js';
import { scenarioManager } from '../scenarioManager.js';

// Synthetic Sundarbans bounding box
const LAT_MIN = 21.5, LAT_MAX = 22.5;
const LON_MIN = 88.0, LON_MAX = 89.5;

function randLat() { return +(LAT_MIN + Math.random() * (LAT_MAX - LAT_MIN)).toFixed(6); }
function randLon() { return +(LON_MIN + Math.random() * (LON_MAX - LON_MIN)).toFixed(6); }

const GPR_CLASSES     = ['TUNNEL', 'CABLE', 'ROCK', 'CLEAR'];
const TRACK_CLASSES   = ['HUMAN', 'VEHICLE', 'ANIMAL', 'UNKNOWN'];
const MW_ZONES        = ['MW-ZONE-1', 'MW-ZONE-2', 'MW-ZONE-3'];

// ── GMTI track state ─────────────────────────────────────────────────────────
class TrackStore {
  #tracks = new Map();   // track_id → Track

  /** Upsert a track object */
  upsert(id, props) {
    const existing = this.#tracks.get(id) ?? { age_frames: 0 };
    this.#tracks.set(id, { ...existing, ...props, track_id: id, age_frames: existing.age_frames + 1 });
  }

  delete(id) { this.#tracks.delete(id); }

  getAll() { return [...this.#tracks.values()]; }

  /** Prune tracks that haven't been updated (age very high) */
  prune(maxAge = 30) {
    for (const [id, t] of this.#tracks) {
      if (t.age_frames > maxAge && Math.random() < 0.3) this.#tracks.delete(id);
    }
  }
}

export class RadarGenerator extends BaseGenerator {
  // GMTI-specific state
  #trackStore = new TrackStore();
  #trackIds   = [];          // pool of stable IDs for this instance
  #breachCount = 0;
  #scanDist    = 0;

  constructor(opts) {
    super({ noiseSigma: 0.02, ...opts });
    // Pre-allocate a pool of persistent track IDs
    for (let i = 0; i < 8; i++) this.#trackIds.push(uuidv4());
  }

  // ── GPR ──────────────────────────────────────────────────────────────────

  #buildGpr(scenario) {
    const isTunnel    = scenario === 'TUNNEL_ACTIVITY';
    const isIntrusion = scenario === 'INTRUSION';

    const anomaly_detected  = isTunnel || (isIntrusion && Math.random() < 0.3) || Math.random() < 0.05;
    const anomaly_confidence = anomaly_detected
      ? +(0.55 + Math.random() * 0.40).toFixed(3)
      : +(Math.random() * 0.25).toFixed(3);

    let classification;
    if (isTunnel && anomaly_detected)        classification = 'TUNNEL';
    else if (isIntrusion && anomaly_detected) classification = Math.random() < 0.5 ? 'CABLE' : 'TUNNEL';
    else if (anomaly_detected)               classification = GPR_CLASSES[Math.floor(Math.random() * 3)];
    else                                     classification = 'CLEAR';

    this.#scanDist = (this.#scanDist + 0.1 + Math.random() * 0.5) % 200;

    const depth_m            = +(Math.random() * 5).toFixed(3);
    const hyperbola_amplitude = anomaly_detected
      ? +(-20 + Math.random() * 15 + this.gaussian(3)).toFixed(2)
      : +(-50 + Math.random() * 10 + this.gaussian(3)).toFixed(2);

    // B-scan row: 128 floats, Gaussian hyperbola centred at mid-scan if anomaly
    const b_scan_row = Array.from({ length: 128 }, (_, i) => {
      const base = anomaly_detected
        ? hyperbola_amplitude * Math.exp(-0.001 * (i - 64) ** 2)
        : this.gaussian(2) - 50;
      return +(base + this.gaussian(1)).toFixed(3);
    });

    return {
      depth_m,
      scan_distance_m:  +this.#scanDist.toFixed(2),
      anomaly_detected,
      anomaly_confidence,
      hyperbola_amplitude,
      classification,
      b_scan_row
    };
  }

  // ── MICROWAVE ────────────────────────────────────────────────────────────

  #buildMicrowave(scenario) {
    const zone_breached =
      scenario === 'INTRUSION' ||
      scenario === 'VEHICLE_CONVOY' ||
      (scenario === 'ELEVATED' && Math.random() < 0.30) ||
      (scenario === 'NORMAL'   && Math.random() < 0.02);

    if (zone_breached) this.#breachCount++;

    return {
      zone_breached,
      breach_count:       this.#breachCount,
      zone_id:            MW_ZONES[Math.floor(Math.random() * MW_ZONES.length)],
      signal_strength_dbm: +(-50 - Math.random() * 30 + this.gaussian(2)).toFixed(2)
    };
  }

  // ── LIDAR ────────────────────────────────────────────────────────────────

  #buildLidar(scenario) {
    let objects_detected, nearest_object_m;

    switch (scenario) {
      case 'INTRUSION':
        objects_detected  = 1 + Math.floor(Math.random() * 3);
        nearest_object_m  = +(5 + Math.random() * 50).toFixed(2);
        break;
      case 'VEHICLE_CONVOY':
        objects_detected  = 3 + Math.floor(Math.random() * 5);
        nearest_object_m  = +(10 + Math.random() * 100).toFixed(2);
        break;
      case 'DRONE':
        objects_detected  = 1;
        nearest_object_m  = +(50 + Math.random() * 150).toFixed(2);
        break;
      default:
        objects_detected  = Math.floor(Math.random() * 2);
        nearest_object_m  = +(50 + Math.random() * 200).toFixed(2);
        break;
    }

    const point_count = 500 + Math.floor(Math.random() * 1500);
    const sx = +(Math.random() * 100 - 50).toFixed(2);
    const sy = +(Math.random() * 100 - 50).toFixed(2);

    return {
      point_count,
      objects_detected,
      nearest_object_m,
      point_cloud_summary: {
        min_x: +( sx - Math.random() * 10).toFixed(2),
        max_x: +( sx + Math.random() * 10).toFixed(2),
        min_y: +( sy - Math.random() * 10).toFixed(2),
        max_y: +( sy + Math.random() * 10).toFixed(2),
        min_z: +(-1 - Math.random() * 2).toFixed(2),
        max_z: +( 1 + Math.random() * 5).toFixed(2)
      }
    };
  }

  // ── MMWAVE ───────────────────────────────────────────────────────────────

  #buildMmwave(scenario) {
    const detCount =
      scenario === 'VEHICLE_CONVOY' ? 2 + Math.floor(Math.random() * 4) :
      scenario === 'INTRUSION'      ? 1 + Math.floor(Math.random() * 3) :
      scenario === 'DRONE'          ? 1 : 0;

    const detections = Array.from({ length: detCount }, () => ({
      range_m:       +(10 + Math.random() * 500).toFixed(1),
      azimuth_deg:   +(Math.random() * 360).toFixed(1),
      velocity_mps:  +((Math.random() - 0.5) * 30).toFixed(2),
      rcs_dbsm:      +(-10 + Math.random() * 20 + this.gaussian(2)).toFixed(2)
    }));

    return {
      detections,
      visibility_m: +(200 + Math.random() * 4800).toFixed(0)
    };
  }

  // ── GMTI ─────────────────────────────────────────────────────────────────

  #buildGmti(scenario) {
    this.#trackStore.prune(40);

    let desiredTracks;
    switch (scenario) {
      case 'INTRUSION':
        desiredTracks = [
          { cls: 'HUMAN',   velRange: [0.5, 1.5], rangeRange: [50, 500]  },
          ...(Math.random() < 0.5 ? [{ cls: 'HUMAN', velRange: [0.5, 1.5], rangeRange: [50, 500] }] : [])
        ];
        break;
      case 'VEHICLE_CONVOY':
        desiredTracks = Array.from({ length: 3 + Math.floor(Math.random() * 4) }, () =>
          ({ cls: 'VEHICLE', velRange: [5, 20], rangeRange: [100, 2000] })
        );
        break;
      case 'DRONE':
        desiredTracks = Math.random() < 0.7
          ? [{ cls: 'UNKNOWN', velRange: [5, 15], rangeRange: [500, 2000] }]
          : [];
        break;
      default: // NORMAL / ELEVATED
        desiredTracks = Math.random() < 0.3
          ? [{ cls: 'ANIMAL', velRange: [0.1, 2.0], rangeRange: [20, 300] }]
          : [];
        break;
    }

    // Upsert tracks
    desiredTracks.forEach((spec, i) => {
      const id = this.#trackIds[i % this.#trackIds.length];
      const velocity = +(spec.velRange[0] + Math.random() * (spec.velRange[1] - spec.velRange[0])).toFixed(2);
      const range_m  = +(spec.rangeRange[0] + Math.random() * (spec.rangeRange[1] - spec.rangeRange[0])).toFixed(1);
      this.#trackStore.upsert(id, {
        lat:        randLat(),
        lon:        randLon(),
        range_m,
        velocity,
        heading:    +(Math.random() * 360).toFixed(1),
        class:      spec.cls,
        confidence: +(0.6 + Math.random() * 0.35).toFixed(3)
      });
    });

    // Drop tracks not in desired list
    const activeTracks = this.#trackStore.getAll();
    if (activeTracks.length > desiredTracks.length) {
      for (let i = desiredTracks.length; i < this.#trackIds.length; i++) {
        this.#trackStore.delete(this.#trackIds[i]);
      }
    }

    const tracks = this.#trackStore.getAll();

    // 64-float range-Doppler map
    const range_doppler_map = Array.from({ length: 64 }, (_, i) => {
      const hasPeak = tracks.some(t => Math.abs(t.velocity) > 0.3 && i % 8 === 0);
      return +(hasPeak ? -20 + Math.random() * 10 : -60 + Math.random() * 5 + this.gaussian(2)).toFixed(2);
    });

    return {
      tracks,
      range_doppler_map,
      coverage_az_deg: +(90 + Math.random() * 270).toFixed(1),
      max_range_m:     +(5000 + Math.random() * 45000).toFixed(0)
    };
  }

  // ── Main generate ─────────────────────────────────────────────────────────

  generate() {
    const scenario = scenarioManager.getScenario();
    let rawValue;

    switch (this.modality) {
      case 'GPR':       rawValue = this.#buildGpr(scenario);       break;
      case 'MICROWAVE': rawValue = this.#buildMicrowave(scenario); break;
      case 'LIDAR':     rawValue = this.#buildLidar(scenario);     break;
      case 'MMWAVE':    rawValue = this.#buildMmwave(scenario);    break;
      case 'GMTI':      rawValue = this.#buildGmti(scenario);      break;
      default:
        rawValue = { error: `Unknown radar modality: ${this.modality}` };
    }

    const isAlert =
      (this.modality === 'MICROWAVE' && rawValue.zone_breached) ||
      (this.modality === 'GPR'       && rawValue.anomaly_detected) ||
      (this.modality === 'GMTI'      && rawValue.tracks?.length > 0) ||
      (this.modality === 'MMWAVE'    && rawValue.detections?.length > 0) ||
      (this.modality === 'LIDAR'     && rawValue.objects_detected > 0);

    const processed = isAlert
      ? { event_detected: true, alert_priority: scenario === 'NORMAL' ? 'LOW' : 'MEDIUM' }
      : { event_detected: false };

    return { rawValue, processed };
  }
}
