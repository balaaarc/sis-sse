/**
 * correlator.js
 * Multi-sensor event correlator.
 *
 * In INTRUSION / DRONE / VEHICLE_CONVOY scenarios it listens for sensor
 * payloads published by generators and groups them into correlated events
 * when multiple modalities fire within a 500 ms window.
 *
 * Emits 'correlated_event' which wsServer broadcasts as AIML_ALERT.
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import scenarioManager from './scenarioManager.js';

// Correlation rules per scenario: required modalities
const CORRELATION_RULES = {
  INTRUSION:       ['SEISMIC', 'ACOUSTIC', 'THERMAL', 'EOTS'],
  DRONE:           ['MMWAVE', 'ACOUSTIC', 'EOTS'],
  VEHICLE_CONVOY:  ['GMTI', 'ACOUSTIC', 'SEISMIC'],
  TUNNEL_ACTIVITY: ['GPR', 'SEISMIC'],
  ELEVATED:        ['SEISMIC', 'ACOUSTIC']
};

const CORRELATION_WINDOW_MS = 500;

class Correlator extends EventEmitter {
  /** @type {Map<string, {timestamp: number, payload: object}>} */
  #recent = new Map();
  #lastEmitAt = 0;

  /**
   * Called by each generator on every tick.
   * @param {object} payload - full sensor payload
   */
  ingest(payload) {
    const scenario = scenarioManager.getScenario();
    const rule = CORRELATION_RULES[scenario];
    if (!rule) return; // NORMAL has no correlation

    const modality = payload.modality;
    const now = Date.now();

    // Evict stale entries
    for (const [key, entry] of this.#recent) {
      if (now - entry.timestamp > CORRELATION_WINDOW_MS) {
        this.#recent.delete(key);
      }
    }

    // Store latest from this modality
    this.#recent.set(modality, { timestamp: now, payload });

    // Check if all required modalities present within window
    const covered = rule.every((mod) => this.#recent.has(mod));
    if (covered && now - this.#lastEmitAt > 2000) {
      // Debounce: emit at most once per 2 s
      this.#lastEmitAt = now;
      this.#emitCorrelatedAlert(scenario, rule);
    }
  }

  #emitCorrelatedAlert(scenario, rule) {
    const contributing = rule
      .map((mod) => this.#recent.get(mod)?.payload?.sensor_id)
      .filter(Boolean);

    const firstPayload = this.#recent.get(rule[0])?.payload;
    const site = firstPayload
      ? { lat: firstPayload.site_lat ?? 21.9452, lon: firstPayload.site_lon ?? 88.1234 }
      : { lat: 21.9452, lon: 88.1234 };

    const threatScoreMap = {
      INTRUSION:       85 + Math.floor(Math.random() * 15),
      DRONE:           70 + Math.floor(Math.random() * 20),
      VEHICLE_CONVOY:  75 + Math.floor(Math.random() * 15),
      TUNNEL_ACTIVITY: 60 + Math.floor(Math.random() * 20),
      ELEVATED:        40 + Math.floor(Math.random() * 20)
    };

    const threatScore = threatScoreMap[scenario] ?? 50;
    const threatLevel = threatScore >= 90 ? 'CRITICAL'
      : threatScore >= 70 ? 'HIGH'
      : threatScore >= 50 ? 'MEDIUM'
      : 'LOW';

    const actionMap = {
      INTRUSION:       'Deploy QRT to sector 4 immediately',
      DRONE:           'Activate counter-UAS systems, track bearing',
      VEHICLE_CONVOY:  'Alert border patrol, establish vehicle checkpoint',
      TUNNEL_ACTIVITY: 'Deploy ground-penetrating survey team',
      ELEVATED:        'Increase sensor sensitivity, stand by QRT'
    };

    const event = {
      alert_id: uuidv4(),
      assessment_id: uuidv4(),
      timestamp: new Date().toISOString(),
      scenario,
      threat_score: threatScore,
      threat_level: threatLevel,
      contributing_sensors: contributing,
      dominant_modality: rule[0],
      location: {
        lat: +(site.lat + (Math.random() - 0.5) * 0.002).toFixed(6),
        lon: +(site.lon + (Math.random() - 0.5) * 0.002).toFixed(6),
        accuracy_m: 30 + Math.floor(Math.random() * 70)
      },
      recommended_action: actionMap[scenario] ?? 'Increase vigilance',
      model_version: 'v2.1.0',
      correlation_window_ms: CORRELATION_WINDOW_MS
    };

    console.log(`[Correlator] Correlated event: ${threatLevel} (score=${threatScore}) scenario=${scenario}`);
    this.emit('correlated_event', event);
  }
}

export const correlator = new Correlator();
