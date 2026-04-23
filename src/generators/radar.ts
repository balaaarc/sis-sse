import { v4 as uuidv4 } from 'uuid';
import { BaseGenerator } from './base.js';
import { scenarioManager } from '../scenarioManager.js';
import type { GeneratorOpts, GenerateResult } from '../types.js';

const LAT_MIN = 21.5, LAT_MAX = 22.5;
const LON_MIN = 88.0, LON_MAX = 89.5;

function randLat(): number { return +(LAT_MIN + Math.random() * (LAT_MAX - LAT_MIN)).toFixed(6); }
function randLon(): number { return +(LON_MIN + Math.random() * (LON_MAX - LON_MIN)).toFixed(6); }

interface Track {
  track_id:    string;
  lat:         number;
  lon:         number;
  range_m:     number;
  velocity:    number;
  heading:     number;
  class:       string;
  confidence:  number;
  age_frames:  number;
}

class TrackStore {
  #tracks = new Map<string, Track>();

  upsert(id: string, props: Omit<Track, 'track_id' | 'age_frames'>): void {
    const existing = this.#tracks.get(id);
    this.#tracks.set(id, {
      ...props,
      track_id:   id,
      age_frames: existing ? existing.age_frames + 1 : 1,
    });
  }

  delete(id: string): void { this.#tracks.delete(id); }
  getAll(): Track[] { return [...this.#tracks.values()]; }

  prune(maxAge = 30): void {
    for (const [id, t] of this.#tracks) {
      if (t.age_frames > maxAge && Math.random() < 0.3) this.#tracks.delete(id);
    }
  }
}

export class RadarGenerator extends BaseGenerator {
  #trackStore = new TrackStore();
  #trackIds: string[] = [];
  #breachCount = 0;
  #scanDist = 0;

  constructor(opts: GeneratorOpts) {
    super({ noiseSigma: 0.02, ...opts });
    for (let i = 0; i < 8; i++) this.#trackIds.push(uuidv4());
  }

  #buildGpr(scenario: string): Record<string, unknown> {
    const isTunnel    = scenario === 'TUNNEL_ACTIVITY';
    const isIntrusion = scenario === 'INTRUSION';

    const anomaly_detected = isTunnel || (isIntrusion && Math.random() < 0.3) || Math.random() < 0.05;
    const anomaly_confidence = anomaly_detected
      ? +(0.55 + Math.random() * 0.40).toFixed(3)
      : +(Math.random() * 0.25).toFixed(3);

    let classification: string;
    if (isTunnel && anomaly_detected)        classification = 'TUNNEL';
    else if (isIntrusion && anomaly_detected) classification = Math.random() < 0.5 ? 'CABLE' : 'TUNNEL';
    else if (anomaly_detected)               classification = ['TUNNEL', 'CABLE', 'ROCK'][Math.floor(Math.random() * 3)];
    else                                     classification = 'CLEAR';

    this.#scanDist = (this.#scanDist + 0.1 + Math.random() * 0.5) % 200;
    const depth_m            = +(Math.random() * 5).toFixed(3);
    const hyperbola_amplitude = anomaly_detected
      ? +(-20 + Math.random() * 15 + this.gaussian(3)).toFixed(2)
      : +(-50 + Math.random() * 10 + this.gaussian(3)).toFixed(2);

    const b_scan_row = Array.from({ length: 128 }, (_, i) => {
      const base = anomaly_detected
        ? hyperbola_amplitude * Math.exp(-0.001 * (i - 64) ** 2)
        : this.gaussian(2) - 50;
      return +(base + this.gaussian(1)).toFixed(3);
    });

    return { depth_m, scan_distance_m: +this.#scanDist.toFixed(2), anomaly_detected, anomaly_confidence, hyperbola_amplitude, classification, b_scan_row };
  }

  #buildMicrowave(scenario: string): Record<string, unknown> {
    const mwZones = ['MW-ZONE-1', 'MW-ZONE-2', 'MW-ZONE-3'];
    const zone_breached =
      scenario === 'INTRUSION' ||
      scenario === 'VEHICLE_CONVOY' ||
      (scenario === 'ELEVATED' && Math.random() < 0.30) ||
      (scenario === 'NORMAL'   && Math.random() < 0.02);

    if (zone_breached) this.#breachCount++;

    return {
      zone_breached,
      breach_count:        this.#breachCount,
      zone_id:             mwZones[Math.floor(Math.random() * mwZones.length)],
      signal_strength_dbm: +(-50 - Math.random() * 30 + this.gaussian(2)).toFixed(2),
    };
  }

  #buildLidar(scenario: string): Record<string, unknown> {
    let objects_detected: number;
    let nearest_object_m: number;

    switch (scenario) {
      case 'INTRUSION':
        objects_detected = 1 + Math.floor(Math.random() * 3);
        nearest_object_m = +(5 + Math.random() * 50).toFixed(2);
        break;
      case 'VEHICLE_CONVOY':
        objects_detected = 3 + Math.floor(Math.random() * 5);
        nearest_object_m = +(10 + Math.random() * 100).toFixed(2);
        break;
      case 'DRONE':
        objects_detected = 1;
        nearest_object_m = +(50 + Math.random() * 150).toFixed(2);
        break;
      default:
        objects_detected = Math.floor(Math.random() * 2);
        nearest_object_m = +(50 + Math.random() * 200).toFixed(2);
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
        min_x: +(sx - Math.random() * 10).toFixed(2),
        max_x: +(sx + Math.random() * 10).toFixed(2),
        min_y: +(sy - Math.random() * 10).toFixed(2),
        max_y: +(sy + Math.random() * 10).toFixed(2),
        min_z: +(-1 - Math.random() * 2).toFixed(2),
        max_z: +(1 + Math.random() * 5).toFixed(2),
      },
    };
  }

  #buildMmwave(scenario: string): Record<string, unknown> {
    const detCount =
      scenario === 'VEHICLE_CONVOY' ? 2 + Math.floor(Math.random() * 4) :
      scenario === 'INTRUSION'      ? 1 + Math.floor(Math.random() * 3) :
      scenario === 'DRONE'          ? 1 : 0;

    const detections = Array.from({ length: detCount }, () => ({
      range_m:      +(10 + Math.random() * 500).toFixed(1),
      azimuth_deg:  +(Math.random() * 360).toFixed(1),
      velocity_mps: +((Math.random() - 0.5) * 30).toFixed(2),
      rcs_dbsm:     +(-10 + Math.random() * 20 + this.gaussian(2)).toFixed(2),
    }));

    return { detections, visibility_m: +(200 + Math.random() * 4800).toFixed(0) };
  }

  #buildGmti(scenario: string): Record<string, unknown> {
    this.#trackStore.prune(40);

    interface TrackSpec { cls: string; velRange: [number, number]; rangeRange: [number, number] }
    let desiredTracks: TrackSpec[];

    switch (scenario) {
      case 'INTRUSION':
        desiredTracks = [
          { cls: 'HUMAN', velRange: [0.5, 1.5], rangeRange: [50, 500] },
          ...(Math.random() < 0.5 ? [{ cls: 'HUMAN', velRange: [0.5, 1.5] as [number, number], rangeRange: [50, 500] as [number, number] }] : []),
        ];
        break;
      case 'VEHICLE_CONVOY':
        desiredTracks = Array.from({ length: 3 + Math.floor(Math.random() * 4) }, () =>
          ({ cls: 'VEHICLE', velRange: [5, 20] as [number, number], rangeRange: [100, 2000] as [number, number] })
        );
        break;
      case 'DRONE':
        desiredTracks = Math.random() < 0.7
          ? [{ cls: 'UNKNOWN', velRange: [5, 15] as [number, number], rangeRange: [500, 2000] as [number, number] }]
          : [];
        break;
      default:
        desiredTracks = Math.random() < 0.3
          ? [{ cls: 'ANIMAL', velRange: [0.1, 2.0] as [number, number], rangeRange: [20, 300] as [number, number] }]
          : [];
        break;
    }

    desiredTracks.forEach((spec, i) => {
      const id       = this.#trackIds[i % this.#trackIds.length];
      const velocity = +(spec.velRange[0] + Math.random() * (spec.velRange[1] - spec.velRange[0])).toFixed(2);
      const range_m  = +(spec.rangeRange[0] + Math.random() * (spec.rangeRange[1] - spec.rangeRange[0])).toFixed(1);
      this.#trackStore.upsert(id, {
        lat:       randLat(),
        lon:       randLon(),
        range_m,
        velocity,
        heading:   +(Math.random() * 360).toFixed(1),
        class:     spec.cls,
        confidence:+(0.6 + Math.random() * 0.35).toFixed(3),
      });
    });

    const activeTracks = this.#trackStore.getAll();
    if (activeTracks.length > desiredTracks.length) {
      for (let i = desiredTracks.length; i < this.#trackIds.length; i++) {
        this.#trackStore.delete(this.#trackIds[i]);
      }
    }

    const tracks = this.#trackStore.getAll();
    const range_doppler_map = Array.from({ length: 64 }, (_, i) => {
      const hasPeak = tracks.some((t) => Math.abs(t.velocity) > 0.3 && i % 8 === 0);
      return +(hasPeak ? -20 + Math.random() * 10 : -60 + Math.random() * 5 + this.gaussian(2)).toFixed(2);
    });

    return {
      tracks,
      range_doppler_map,
      coverage_az_deg: +(90 + Math.random() * 270).toFixed(1),
      max_range_m:     +(5000 + Math.random() * 45000).toFixed(0),
    };
  }

  generate(): GenerateResult {
    const scenario = scenarioManager.getScenario();
    let rawValue: Record<string, unknown>;

    switch (this.modality) {
      case 'GPR':       rawValue = this.#buildGpr(scenario);       break;
      case 'MICROWAVE': rawValue = this.#buildMicrowave(scenario); break;
      case 'LIDAR':     rawValue = this.#buildLidar(scenario);     break;
      case 'MMWAVE':    rawValue = this.#buildMmwave(scenario);    break;
      case 'GMTI_RADAR':rawValue = this.#buildGmti(scenario);      break;
      default:          rawValue = { error: `Unknown radar modality: ${this.modality}` };
    }

    const isAlert =
      (this.modality === 'MICROWAVE'   && (rawValue.zone_breached as boolean)) ||
      (this.modality === 'GPR'         && (rawValue.anomaly_detected as boolean)) ||
      (this.modality === 'GMTI_RADAR'  && (rawValue.tracks as Track[])?.length > 0) ||
      (this.modality === 'MMWAVE'      && (rawValue.detections as unknown[])?.length > 0) ||
      (this.modality === 'LIDAR'       && (rawValue.objects_detected as number) > 0);

    const processed = isAlert
      ? { event_detected: true, alert_priority: scenario === 'NORMAL' ? 'LOW' : 'MEDIUM' }
      : { event_detected: false };

    return { rawValue, processed };
  }
}
