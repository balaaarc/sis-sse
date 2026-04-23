import { v4 as uuidv4 } from 'uuid';
import { scenarioManager } from '../scenarioManager.js';
import { addAlert } from '../restServer.js';
import { logger } from '../logger.js';
import type { IWsServer, ScenarioName, ThreatLevel, SiteConfig, AlertRecord } from '../types.js';
import type { BaseGenerator } from './base.js';

const LAT_MIN = 21.5, LAT_MAX = 22.5;
const LON_MIN = 88.0, LON_MAX = 89.5;

function randLat(): number { return +(LAT_MIN + Math.random() * (LAT_MAX - LAT_MIN)).toFixed(6); }
function randLon(): number { return +(LON_MIN + Math.random() * (LON_MAX - LON_MIN)).toFixed(6); }
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function rand(lo: number, hi: number): number { return lo + Math.random() * (hi - lo); }

interface ScenarioThreat { level: ThreatLevel; score: [number, number]; confidence: [number, number]; modality: string }
interface ScenarioTrack  { count: [number, number]; classes: string[]; velRange: [number, number]; rangeRange: [number, number] }
interface ScenarioDetect { prob: number; classes: string[]; confRange: [number, number] }

const SCENARIO_THREAT: Record<ScenarioName, ScenarioThreat> = {
  NORMAL:         { level: 'CLEAR',    score: [5,  20], confidence: [0.85, 0.98], modality: 'SEISMIC'    },
  ELEVATED:       { level: 'MEDIUM',   score: [31, 55], confidence: [0.70, 0.88], modality: 'ACOUSTIC'   },
  INTRUSION:      { level: 'HIGH',     score: [71, 88], confidence: [0.75, 0.95], modality: 'SEISMIC'    },
  TUNNEL_ACTIVITY:{ level: 'MEDIUM',   score: [40, 65], confidence: [0.65, 0.85], modality: 'GPR'        },
  DRONE:          { level: 'HIGH',     score: [71, 85], confidence: [0.70, 0.90], modality: 'MMWAVE'     },
  VEHICLE_CONVOY: { level: 'CRITICAL', score: [88, 99], confidence: [0.82, 0.97], modality: 'GMTI_RADAR' },
};

const SCENARIO_TRACKS: Record<ScenarioName, ScenarioTrack> = {
  NORMAL:         { count: [0, 1], classes: ['ANIMAL'],            velRange: [0.0, 1.5],  rangeRange: [20,  300]  },
  ELEVATED:       { count: [0, 2], classes: ['ANIMAL', 'UNKNOWN'], velRange: [0.0, 3.0],  rangeRange: [20,  500]  },
  INTRUSION:      { count: [1, 2], classes: ['HUMAN'],             velRange: [0.5, 1.5],  rangeRange: [50,  500]  },
  TUNNEL_ACTIVITY:{ count: [0, 1], classes: ['HUMAN', 'UNKNOWN'],  velRange: [0.1, 0.8],  rangeRange: [10,  200]  },
  DRONE:          { count: [1, 1], classes: ['UNKNOWN'],           velRange: [5.0, 15.0], rangeRange: [200, 2000] },
  VEHICLE_CONVOY: { count: [3, 6], classes: ['VEHICLE'],           velRange: [5.0, 20.0], rangeRange: [100, 2000] },
};

const SCENARIO_DETECTIONS: Record<ScenarioName, ScenarioDetect> = {
  NORMAL:         { prob: 0.05, classes: ['ANIMAL'],                        confRange: [0.35, 0.60] },
  ELEVATED:       { prob: 0.25, classes: ['HUMAN', 'ANIMAL', 'UNKNOWN'],    confRange: [0.45, 0.70] },
  INTRUSION:      { prob: 0.80, classes: ['HUMAN'],                         confRange: [0.75, 0.95] },
  TUNNEL_ACTIVITY:{ prob: 0.35, classes: ['HUMAN', 'UNKNOWN'],              confRange: [0.55, 0.80] },
  DRONE:          { prob: 0.75, classes: ['UNKNOWN'],                       confRange: [0.65, 0.88] },
  VEHICLE_CONVOY: { prob: 0.90, classes: ['VEHICLE'],                       confRange: [0.85, 0.98] },
};

interface TrackEntry {
  track_id:   string;
  lat:        number;
  lon:        number;
  range_m:    number;
  velocity:   number;
  heading:    number;
  class:      string;
  confidence: number;
  age_frames: number;
}

class TrackPool {
  #tracks = new Map<string, TrackEntry>();
  #idPool = Array.from({ length: 8 }, () => uuidv4());

  update(scenario: ScenarioName): TrackEntry[] {
    const spec         = SCENARIO_TRACKS[scenario] ?? SCENARIO_TRACKS.NORMAL;
    const desiredCount = Math.floor(rand(spec.count[0], spec.count[1] + 1));

    const ids = [...this.#tracks.keys()];
    for (let i = desiredCount; i < ids.length; i++) this.#tracks.delete(ids[i]);

    for (let i = 0; i < desiredCount; i++) {
      const id  = this.#idPool[i];
      const cls = spec.classes[Math.floor(Math.random() * spec.classes.length)];
      const vel = +rand(spec.velRange[0], spec.velRange[1]).toFixed(2);
      const rng = +rand(spec.rangeRange[0], spec.rangeRange[1]).toFixed(1);
      const old = this.#tracks.get(id);
      this.#tracks.set(id, {
        track_id:   id,
        lat:        old ? +(old.lat + (Math.random() - 0.5) * 0.001).toFixed(6) : randLat(),
        lon:        old ? +(old.lon + (Math.random() - 0.5) * 0.001).toFixed(6) : randLon(),
        range_m:    rng,
        velocity:   vel,
        heading:    +(Math.random() * 360).toFixed(1),
        class:      cls,
        confidence: +rand(0.60, 0.95).toFixed(3),
        age_frames: old ? old.age_frames + 1 : 1,
      });
    }

    return [...this.#tracks.values()];
  }
}

export class AimlGenerator {
  #trackPool = new TrackPool();
  readonly generators: BaseGenerator[];
  readonly site: SiteConfig;

  constructor({ generators, site }: { generators: BaseGenerator[]; site: SiteConfig }) {
    this.generators = generators;
    this.site       = site;
  }

  start(wsServer: IWsServer): void {
    setInterval(() => {
      const payload = this.buildThreatAssessment();
      wsServer.broadcast({ type: 'THREAT_ASSESSMENT', payload });

      if (payload.threat_level === 'HIGH' || payload.threat_level === 'CRITICAL') {
        const alert: AlertRecord = {
          alert_id:             uuidv4(),
          assessment_id:        payload.assessment_id,
          timestamp:            payload.timestamp,
          threat_level:         payload.threat_level,
          threat_score:         payload.threat_score,
          contributing_sensors: payload.contributing_sensors,
          dominant_modality:    payload.dominant_modality,
          location:             payload.location,
          recommended_action:   payload.recommended_action,
          model_version:        payload.model_version,
          scenario:             payload.scenario,
          site_id:              this.site.site_id,
          source:               'AIML_THREAT_ASSESSMENT',
        };
        addAlert(alert);
        wsServer.broadcast({ type: 'AIML_ALERT', payload: alert });
      }
    }, 5000);

    setInterval(() => {
      wsServer.broadcast({ type: 'AIML_TRACK_UPDATE', payload: this.buildTrackUpdate() });
    }, 1000);

    setInterval(() => {
      const det = this.buildDetection();
      if (det) wsServer.broadcast({ type: 'AIML_DETECTION', payload: det });
    }, 500);

    logger.info('AimlGenerator started: THREAT_ASSESSMENT@5s, TRACK_UPDATE@1s, DETECTION@500ms');
  }

  buildThreatAssessment(): Record<string, unknown> & {
    assessment_id: string; timestamp: string; threat_level: ThreatLevel;
    threat_score: number; contributing_sensors: string[]; dominant_modality: string;
    location: object; recommended_action: string; model_version: string; scenario: string;
  } {
    const scenario = scenarioManager.getScenario();
    const spec     = SCENARIO_THREAT[scenario] ?? SCENARIO_THREAT.NORMAL;

    const threat_score = +rand(spec.score[0], spec.score[1]).toFixed(1);
    const confidence   = +rand(spec.confidence[0], spec.confidence[1]).toFixed(4);

    const contributing_sensors = this.generators
      .filter(() => Math.random() > 0.5)
      .map((g) => g.sensorId)
      .slice(0, 4);

    return {
      assessment_id:        uuidv4(),
      timestamp:            new Date().toISOString(),
      threat_score,
      threat_level:         spec.level,
      contributing_sensors,
      dominant_modality:    spec.modality,
      location: {
        lat:        +(this.site.lat + (Math.random() - 0.5) * 0.005).toFixed(6),
        lon:        +(this.site.lon + (Math.random() - 0.5) * 0.005).toFixed(6),
        accuracy_m: 25 + Math.floor(Math.random() * 75),
      },
      recommended_action: this.#recommendedAction(spec.level),
      model_version:      'bayesian-v3.1',
      site_id:            this.site.site_id,
      bop_id:             this.site.bop_id,
      scenario,
      confidence,
    };
  }

  buildTrackUpdate(): Record<string, unknown> {
    const scenario = scenarioManager.getScenario();
    const tracks   = this.#trackPool.update(scenario);
    return {
      update_id:   uuidv4(),
      timestamp:   new Date().toISOString(),
      site_id:     this.site.site_id,
      scenario,
      track_count: tracks.length,
      tracks,
    };
  }

  buildDetection(): Record<string, unknown> | null {
    const scenario = scenarioManager.getScenario();
    const spec     = SCENARIO_DETECTIONS[scenario] ?? SCENARIO_DETECTIONS.NORMAL;

    if (Math.random() > spec.prob) return null;

    const cls        = spec.classes[Math.floor(Math.random() * spec.classes.length)];
    const confidence = +rand(spec.confRange[0], spec.confRange[1]).toFixed(3);

    const isDrone = scenario === 'DRONE';
    const bboxY   = isDrone ? rand(0.0, 0.25) : rand(0.2, 0.85);
    const bboxW   = isDrone ? rand(0.01, 0.05) : rand(0.05, 0.20);
    const bboxH   = isDrone ? rand(0.01, 0.05) : rand(0.08, 0.25);
    const bboxX   = rand(0, clamp(1 - bboxW, 0, 1));

    const sourceSensor = this.generators.find((g) =>
      ['EOTS', 'PTZ', 'CCTV', 'THERMAL', 'GMTI', 'LIDAR'].includes(g.modality)
    );

    const detection = {
      detection_id: uuidv4(),
      timestamp:    new Date().toISOString(),
      site_id:      this.site.site_id,
      class:        cls,
      confidence,
      bbox:         [+bboxX.toFixed(4), +bboxY.toFixed(4), +bboxW.toFixed(4), +bboxH.toFixed(4)],
      sensor_id:    sourceSensor?.sensorId ?? 'AIML-FUSION',
      location:     { lat: randLat(), lon: randLon() },
    };

    if (cls === 'HUMAN' && confidence > 0.82) {
      addAlert({
        alert_id:     uuidv4(),
        timestamp:    new Date().toISOString(),
        type:         'AIML_ALERT',
        threat_level: 'HIGH',
        source:       'AIML_DETECTION',
        detection_id: detection.detection_id,
        class:        cls,
        confidence,
        site_id:      this.site.site_id,
      });
    }

    return detection;
  }

  #recommendedAction(level: ThreatLevel): string {
    switch (level) {
      case 'CRITICAL': return 'IMMEDIATE_RESPONSE — deploy QRF, initiate lockdown protocol';
      case 'HIGH':     return 'ALERT_QRF — raise readiness, cross-cue sensors, monitor closely';
      case 'MEDIUM':   return 'INCREASE_SURVEILLANCE — PTZ slew-to-cue, increase patrol frequency';
      default:         return 'CONTINUE_MONITORING — maintain normal patrol cycle';
    }
  }
}
