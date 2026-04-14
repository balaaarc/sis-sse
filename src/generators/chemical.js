/**
 * chemical.js
 * Covers S20 Vapor/Explosive Trace Detector — 0.2 Hz (5000ms).
 *
 * raw_value schema:
 *   compound_id         – RDX|TNT|PETN|NH4NO3|NONE
 *   concentration_ppb   – <0.5 baseline, >10 alert
 *   alarm               – bool
 *   detector_temp_c     – operating temperature
 *   compounds           – [{compound_id, concentration_ppb}] all detected
 */

import { BaseGenerator } from './base.js';
import scenarioManager from '../scenarioManager.js';

const ALL_COMPOUNDS  = ['RDX', 'TNT', 'PETN', 'NH4NO3'];
const EXPLOSIVE_PAIR = ['RDX', 'TNT', 'PETN'];

export default class ChemicalGenerator extends BaseGenerator {
  // Detector operating temperature drifts slowly around 35°C
  #detectorTemp = 33 + Math.random() * 5;

  constructor(opts) {
    super({ noiseSigma: 0.01, ...opts });
  }

  generate() {
    const scenario = scenarioManager.getScenario();

    let compound_id, concentration_ppb, extraCompounds;

    switch (scenario) {
      case 'INTRUSION': {
        // 30% chance of explosive detection
        if (Math.random() < 0.30) {
          compound_id       = EXPLOSIVE_PAIR[Math.floor(Math.random() * EXPLOSIVE_PAIR.length)];
          concentration_ppb = +(5 + Math.random() * 20).toFixed(4);   // 5-25 ppb
        } else {
          compound_id       = 'NONE';
          concentration_ppb = +(Math.random() * 0.5).toFixed(4);
        }
        break;
      }

      case 'TUNNEL_ACTIVITY': {
        // Mining — ammonium nitrate
        compound_id       = 'NH4NO3';
        concentration_ppb = +(8 + Math.random() * 22).toFixed(4);     // 8-30 ppb
        break;
      }

      case 'ELEVATED': {
        if (Math.random() < 0.10) {
          compound_id       = ALL_COMPOUNDS[Math.floor(Math.random() * ALL_COMPOUNDS.length)];
          concentration_ppb = +(1 + Math.random() * 5).toFixed(4);
        } else {
          compound_id       = 'NONE';
          concentration_ppb = +(Math.random() * 0.5).toFixed(4);
        }
        break;
      }

      default: // NORMAL / DRONE / VEHICLE_CONVOY
        compound_id       = 'NONE';
        concentration_ppb = +(Math.random() * 0.5 + this.gaussian(0.05)).toFixed(4);
        concentration_ppb = Math.max(0, concentration_ppb);
        break;
    }

    // Add noise to concentration
    concentration_ppb = +Math.max(
      0,
      concentration_ppb + this.gaussian(concentration_ppb * 0.05 + 0.01)
    ).toFixed(4);

    const alarm = compound_id !== 'NONE' && concentration_ppb > 10;

    // Build multi-compound list (always include primary, sometimes add traces)
    extraCompounds = [];
    if (compound_id !== 'NONE') {
      // Occasional trace of another compound
      if (Math.random() < 0.25) {
        const others = ALL_COMPOUNDS.filter(c => c !== compound_id);
        const trace  = others[Math.floor(Math.random() * others.length)];
        extraCompounds.push({
          compound_id:       trace,
          concentration_ppb: +(0.1 + Math.random() * 1.5).toFixed(4)
        });
      }
    }

    const compounds = [
      { compound_id, concentration_ppb },
      ...extraCompounds
    ];

    // Slowly drift detector temperature
    this.#detectorTemp += this.gaussian(0.2);
    this.#detectorTemp  = this.clamp(this.#detectorTemp, 25, 55);

    const rawValue = {
      compound_id,
      concentration_ppb,
      alarm,
      detector_temp_c: +this.#detectorTemp.toFixed(2),
      compounds
    };

    const processed = alarm
      ? {
          event_detected: true,
          classification: compound_id,
          alert_priority: concentration_ppb > 20 ? 'HIGH' : 'MEDIUM'
        }
      : { event_detected: false };

    return { rawValue, processed };
  }
}
