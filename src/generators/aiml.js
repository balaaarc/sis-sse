/**
 * aiml.js
 * AIML meta-generator — NOT a sensor generator, does not extend BaseGenerator.
 *
 * Produces three broadcast streams:
 *   THREAT_ASSESSMENT  every 5 000 ms
 *   AIML_TRACK_UPDATE  every 1 000 ms
 *   AIML_DETECTION     every   500 ms (conditional)
 *
 * Also calls addAlert() whenever a high-priority AIML_ALERT is generated.
 */

import { v4 as uuidv4 } from 'uuid';
import scenarioManager from '../scenarioManager.js';
import { addAlert } from '../restServer.js';

// Synthetic Sundarbans bounding box (SEC-007)
const LAT_MIN = 21.5, LAT_MAX = 22.5;
const LON_MIN = 88.0, LON_MAX = 89.5;

function randLat() { return +(LAT_MIN + Math.random() * (LAT_MAX - LAT_MIN)).toFixed(6); }
function randLon() { return +(LON_MIN + Math.random() * (LON_MAX - LON_MIN)).toFixed(6); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

// ── Scenario tables ──────────────────────────────────────────────────────────

const SCENARIO_THREAT = {
  NORMAL:         { level: 'CLEAR',    score: [5,  20],  confidence: [0.85, 0.98], modality: 'SEISMIC' },
  ELEVATED:       { level: 'MEDIUM',   score: [31, 55],  confidence: [0.70, 0.88], modality: 'ACOUSTIC' },
  INTRUSION:      { level: 'HIGH',     score: [71, 88],  confidence: [0.75, 0.95], modality: 'SEISMIC' },
  TUNNEL_ACTIVITY:{ level: 'MEDIUM',   score: [40, 65],  confidence: [0.65, 0.85], modality: 'GPR' },
  DRONE:          { level: 'HIGH',     score: [71, 85],  confidence: [0.70, 0.90], modality: 'MMWAVE' },
  VEHICLE_CONVOY: { level: 'CRITICAL', score: [88, 99],  confidence: [0.82, 0.97], modality: 'GMTI_RADAR' }
};

const SCENARIO_TRACKS = {
  NORMAL:         { count: [0, 1], classes: ['ANIMAL'],            velRange: [0.0, 1.5],  rangeRange: [20,  300]  },
  ELEVATED:       { count: [0, 2], classes: ['ANIMAL', 'UNKNOWN'], velRange: [0.0, 3.0],  rangeRange: [20,  500]  },
  INTRUSION:      { count: [1, 2], classes: ['HUMAN'],             velRange: [0.5, 1.5],  rangeRange: [50,  500]  },
  TUNNEL_ACTIVITY:{ count: [0, 1], classes: ['HUMAN', 'UNKNOWN'],  velRange: [0.1, 0.8],  rangeRange: [10,  200]  },
  DRONE:          { count: [1, 1], classes: ['UNKNOWN'],           velRange: [5.0, 15.0], rangeRange: [200, 2000] },
  VEHICLE_CONVOY: { count: [3, 6], classes: ['VEHICLE'],           velRange: [5.0, 20.0], rangeRange: [100, 2000] }
};

const SCENARIO_DETECTIONS = {
  NORMAL:         { prob: 0.05, classes: ['ANIMAL'],   confRange: [0.35, 0.60] },
  ELEVATED:       { prob: 0.25, classes: ['HUMAN', 'ANIMAL', 'UNKNOWN'], confRange: [0.45, 0.70] },
  INTRUSION:      { prob: 0.80, classes: ['HUMAN'],    confRange: [0.75, 0.95] },
  TUNNEL_ACTIVITY:{ prob: 0.35, classes: ['HUMAN', 'UNKNOWN'], confRange: [0.55, 0.80] },
  DRONE:          { prob: 0.75, classes: ['UNKNOWN'],  confRange: [0.65, 0.88] },
  VEHICLE_CONVOY: { prob: 0.90, classes: ['VEHICLE'],  confRange: [0.85, 0.98] }
};

// ── Stable track pool (persists across ticks) ────────────────────────────────

class TrackPool {
  #tracks = new Map();
  #idPool = Array.from({ length: 8 }, () => uuidv4());

  update(scenario) {
    const spec = SCENARIO_TRACKS[scenario] ?? SCENARIO_TRACKS.NORMAL;
    const desiredCount = Math.floor(rand(spec.count[0], spec.count[1] + 1));

    // Remove stale tracks beyond desired count
    const ids = [...this.#tracks.keys()];
    for (let i = desiredCount; i < ids.length; i++) {
      this.#tracks.delete(ids[i]);
    }

    // Upsert / add tracks up to desired count
    for (let i = 0; i < desiredCount; i++) {
      const id  = this.#idPool[i];
      const cls = spec.classes[Math.floor(Math.random() * spec.classes.length)];
      const vel = +rand(spec.velRange[0], spec.velRange[1]).toFixed(2);
      const rng = +rand(spec.rangeRange[0], spec.rangeRange[1]).toFixed(1);
      const old = this.#tracks.get(id);
      this.#tracks.set(id, {
        track_id:    id,
        lat:         old ? +(old.lat + (Math.random() - 0.5) * 0.001).toFixed(6) : randLat(),
        lon:         old ? +(old.lon + (Math.random() - 0.5) * 0.001).toFixed(6) : randLon(),
        range_m:     rng,
        velocity:    vel,
        heading:     +(Math.random() * 360).toFixed(1),
        class:       cls,
        confidence:  +rand(0.60, 0.95).toFixed(3),
        age_frames:  old ? old.age_frames + 1 : 1
      });
    }

    return [...this.#tracks.values()];
  }
}

// ── AimlGenerator ────────────────────────────────────────────────────────────

export default class AimlGenerator {
  #trackPool = new TrackPool();

  /**
   * @param {object} opts
   * @param {Array}  opts.generators – all sensor generator instances
   * @param {object} opts.site       – { site_id, bop_id, lat, lon }
   */
  constructor({ generators, site }) {
    this.generators = generators;
    this.site       = site;
  }

  // ── Public entry point ───────────────────────────────────────────────────

  start(wsServer) {
    this.wsServer = wsServer;

    // THREAT_ASSESSMENT every 5 s
    setInterval(() => {
      const payload = this.buildThreatAssessment();
      wsServer.broadcast({ type: 'THREAT_ASSESSMENT', payload });

      // Raise an alert for HIGH / CRITICAL threats
      if (payload.threat_level === 'HIGH' || payload.threat_level === 'CRITICAL') {
        const alert = {
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
          source:               'AIML_THREAT_ASSESSMENT'
        };
        addAlert(alert);
        wsServer.broadcast({ type: 'AIML_ALERT', payload: alert });
      }
    }, 5000);

    // AIML_TRACK_UPDATE every 1 s
    setInterval(() => {
      wsServer.broadcast({ type: 'AIML_TRACK_UPDATE', payload: this.buildTrackUpdate() });
    }, 1000);

    // AIML_DETECTION every 500 ms (conditional)
    setInterval(() => {
      const det = this.buildDetection();
      if (det) wsServer.broadcast({ type: 'AIML_DETECTION', payload: det });
    }, 500);

    console.log('[AimlGenerator] Started: THREAT_ASSESSMENT@5s, TRACK_UPDATE@1s, DETECTION@500ms');
  }

  // ── Builders ─────────────────────────────────────────────────────────────

  buildThreatAssessment() {
    const scenario = scenarioManager.getScenario();
    const spec     = SCENARIO_THREAT[scenario] ?? SCENARIO_THREAT.NORMAL;

    // threat_score is 0-100 per SRD §5.3.1
    const threat_score = +rand(spec.score[0], spec.score[1]).toFixed(1);
    const confidence   = +rand(spec.confidence[0], spec.confidence[1]).toFixed(4);

    // Derive contributing_sensors from registered generators
    const contributing_sensors = this.generators
      .filter(() => Math.random() > 0.5)
      .map(g => g.sensorId)
      .slice(0, 4);

    return {
      assessment_id:        uuidv4(),
      timestamp:            new Date().toISOString(),
      threat_score,
      threat_level:         spec.level,
      contributing_sensors,
      dominant_modality:    spec.modality,
      location: {
        lat: +(this.site.lat + (Math.random() - 0.5) * 0.005).toFixed(6),
        lon: +(this.site.lon + (Math.random() - 0.5) * 0.005).toFixed(6),
        accuracy_m: 25 + Math.floor(Math.random() * 75)
      },
      recommended_action:   this.#recommendedAction(spec.level),
      model_version:        'bayesian-v3.1',
      // Extra context fields
      site_id:              this.site.site_id,
      bop_id:               this.site.bop_id,
      scenario,
      confidence,
    };
  }

  buildTrackUpdate() {
    const scenario = scenarioManager.getScenario();
    const tracks   = this.#trackPool.update(scenario);

    return {
      update_id:  uuidv4(),
      timestamp:  new Date().toISOString(),
      site_id:    this.site.site_id,
      scenario,
      track_count: tracks.length,
      tracks
    };
  }

  buildDetection() {
    const scenario = scenarioManager.getScenario();
    const spec     = SCENARIO_DETECTIONS[scenario] ?? SCENARIO_DETECTIONS.NORMAL;

    if (Math.random() > spec.prob) return null;

    const cls        = spec.classes[Math.floor(Math.random() * spec.classes.length)];
    const confidence = +rand(spec.confRange[0], spec.confRange[1]).toFixed(3);

    // Bounding box (normalised 0-1)
    const isDrone = scenario === 'DRONE';
    const bboxY   = isDrone ? rand(0.0, 0.25) : rand(0.2, 0.85);
    const bboxW   = isDrone ? rand(0.01, 0.05) : rand(0.05, 0.20);
    const bboxH   = isDrone ? rand(0.01, 0.05) : rand(0.08, 0.25);
    const bboxX   = rand(0, clamp(1 - bboxW, 0, 1));

    // Source sensor: pick first optical or radar generator as responsible sensor
    const sourceSensor = this.generators.find(g =>
      ['EOTS', 'PTZ', 'CCTV', 'THERMAL', 'GMTI', 'LIDAR'].includes(g.modality)
    );

    const detection = {
      detection_id: uuidv4(),
      timestamp:    new Date().toISOString(),
      site_id:      this.site.site_id,
      class:        cls,
      confidence,
      bbox:         [
        +bboxX.toFixed(4), +bboxY.toFixed(4),
        +bboxW.toFixed(4), +bboxH.toFixed(4)
      ],
      sensor_id:    sourceSensor?.sensorId ?? 'AIML-FUSION',
      location: {
        lat: randLat(),
        lon: randLon()
      }
    };

    // High-confidence HUMAN detection → alert
    if (cls === 'HUMAN' && confidence > 0.82) {
      addAlert({
        alert_id:    uuidv4(),
        timestamp:   new Date().toISOString(),
        type:        'AIML_ALERT',
        threat_level:'HIGH',
        source:      'AIML_DETECTION',
        detection_id: detection.detection_id,
        class:        cls,
        confidence,
        site_id:      this.site.site_id
      });
    }

    return detection;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  #threatFactors(scenario) {
    const base = {
      acoustic_anomaly:    +(Math.random() * 0.30).toFixed(3),
      seismic_anomaly:     +(Math.random() * 0.20).toFixed(3),
      optical_detection:   +(Math.random() * 0.25).toFixed(3),
      magnetic_anomaly:    +(Math.random() * 0.15).toFixed(3),
      radar_track_count:   0,
      fibre_event:         false,
      chemical_alarm:      false
    };

    switch (scenario) {
      case 'INTRUSION':
        base.acoustic_anomaly  = +rand(0.55, 0.95).toFixed(3);
        base.seismic_anomaly   = +rand(0.50, 0.90).toFixed(3);
        base.optical_detection = +rand(0.70, 0.95).toFixed(3);
        base.magnetic_anomaly  = +rand(0.40, 0.80).toFixed(3);
        base.fibre_event       = Math.random() < 0.75;
        base.radar_track_count = 1 + Math.floor(Math.random() * 2);
        break;
      case 'VEHICLE_CONVOY':
        base.acoustic_anomaly  = +rand(0.75, 0.98).toFixed(3);
        base.seismic_anomaly   = +rand(0.70, 0.95).toFixed(3);
        base.optical_detection = +rand(0.85, 0.98).toFixed(3);
        base.magnetic_anomaly  = +rand(0.80, 0.98).toFixed(3);
        base.radar_track_count = 3 + Math.floor(Math.random() * 4);
        base.fibre_event       = true;
        break;
      case 'DRONE':
        base.acoustic_anomaly  = +rand(0.40, 0.70).toFixed(3);
        base.optical_detection = +rand(0.50, 0.85).toFixed(3);
        base.radar_track_count = 1;
        break;
      case 'TUNNEL_ACTIVITY':
        base.seismic_anomaly   = +rand(0.45, 0.75).toFixed(3);
        base.magnetic_anomaly  = +rand(0.40, 0.70).toFixed(3);
        base.chemical_alarm    = Math.random() < 0.40;
        break;
      case 'ELEVATED':
        base.acoustic_anomaly  = +rand(0.25, 0.55).toFixed(3);
        base.seismic_anomaly   = +rand(0.20, 0.45).toFixed(3);
        break;
      default:
        break;
    }

    return base;
  }

  #recommendedAction(level) {
    switch (level) {
      case 'CRITICAL': return 'IMMEDIATE_RESPONSE — deploy QRF, initiate lockdown protocol';
      case 'HIGH':     return 'ALERT_QRF — raise readiness, cross-cue sensors, monitor closely';
      case 'MEDIUM':   return 'INCREASE_SURVEILLANCE — PTZ slew-to-cue, increase patrol frequency';
      default:         return 'CONTINUE_MONITORING — maintain normal patrol cycle';
    }
  }
}
