/**
 * magnetic.js
 * Covers S04 MAD, S14 MAGNETOMETER, S19 EMI — all at 1 Hz (1000ms).
 *
 * MAD raw_value:
 *   field_delta_nt, anomaly_flag, baseline_nt, confidence
 *
 * MAGNETOMETER raw_value:
 *   metal_mass_kg_equiv, confidence, field_x_nt, field_y_nt, field_z_nt
 *
 * EMI raw_value:
 *   inductance_anomaly, buried_object_signature (32 floats),
 *   classification (METAL|WIRE|CLEAR), confidence
 */

import { BaseGenerator } from './base.js';
import { scenarioManager } from '../scenarioManager.js';

const EMI_CLASSES = ['METAL', 'WIRE', 'CLEAR'];

export class MagneticGenerator extends BaseGenerator {
  // Slow-drifting earth background field (nT)
  #baselineNt = 48000 + (Math.random() - 0.5) * 2000;  // ~48 000 nT typical

  constructor(opts) {
    super({ noiseSigma: 0.015, ...opts });
  }

  // ── MAD ──────────────────────────────────────────────────────────────────

  #buildMad(scenario) {
    let deltaBase, anomaly_flag, confidence;

    switch (scenario) {
      case 'INTRUSION':
        // Person carrying metal equipment
        deltaBase    = 150 + Math.random() * 150;     // 150-300 nT
        anomaly_flag = true;
        confidence   = +(0.65 + Math.random() * 0.30).toFixed(3);
        break;
      case 'VEHICLE_CONVOY':
        deltaBase    = 500 + Math.random() * 1500;    // 500-2000 nT
        anomaly_flag = true;
        confidence   = +(0.80 + Math.random() * 0.18).toFixed(3);
        break;
      case 'TUNNEL_ACTIVITY':
        deltaBase    = 100 + Math.random() * 100;     // 100-200 nT
        anomaly_flag = deltaBase > 150;
        confidence   = +(0.55 + Math.random() * 0.30).toFixed(3);
        break;
      case 'ELEVATED':
        deltaBase    = 30 + Math.random() * 80;
        anomaly_flag = deltaBase > 70;
        confidence   = +(0.45 + Math.random() * 0.35).toFixed(3);
        break;
      default: // NORMAL
        deltaBase    = (Math.random() - 0.5) * 100;   // ±50 nT
        anomaly_flag = false;
        confidence   = +(0.30 + Math.random() * 0.30).toFixed(3);
        break;
    }

    const field_delta_nt = +(deltaBase + this.gaussian(deltaBase * 0.05)).toFixed(3);
    // Slowly drift baseline
    this.#baselineNt += this.gaussian(0.5);

    return {
      field_delta_nt,
      anomaly_flag,
      baseline_nt: +this.#baselineNt.toFixed(2),
      confidence
    };
  }

  // ── MAGNETOMETER ─────────────────────────────────────────────────────────

  #buildMagnetometer(scenario) {
    let metalMassBase, confidence;

    switch (scenario) {
      case 'VEHICLE_CONVOY':
        metalMassBase = 50  + Math.random() * 150;    // 50-200 kg
        confidence    = +(0.82 + Math.random() * 0.15).toFixed(3);
        break;
      case 'INTRUSION':
        metalMassBase = 5   + Math.random() * 15;     // 5-20 kg (person + gear)
        confidence    = +(0.65 + Math.random() * 0.25).toFixed(3);
        break;
      case 'ELEVATED':
        metalMassBase = 2   + Math.random() * 8;
        confidence    = +(0.40 + Math.random() * 0.35).toFixed(3);
        break;
      default:
        metalMassBase = Math.random() * 5;            // 0-5 kg (background)
        confidence    = +(0.20 + Math.random() * 0.30).toFixed(3);
        break;
    }

    const metal_mass_kg_equiv = +Math.max(0, metalMassBase + this.gaussian(metalMassBase * 0.08)).toFixed(3);

    // Earth field components (nT) with small noise
    const field_x_nt = +((this.#baselineNt * 0.30) + this.gaussian(20)).toFixed(2);
    const field_y_nt = +((this.#baselineNt * 0.10) + this.gaussian(20)).toFixed(2);
    const field_z_nt = +((this.#baselineNt * 0.95) + this.gaussian(20)).toFixed(2);

    return { metal_mass_kg_equiv, confidence, field_x_nt, field_y_nt, field_z_nt };
  }

  // ── EMI ──────────────────────────────────────────────────────────────────

  #buildEmi(scenario) {
    let anomalyBase, classification, confidence;

    switch (scenario) {
      case 'TUNNEL_ACTIVITY':
        anomalyBase    = 0.50 + Math.random() * 0.45;
        classification = 'METAL';
        confidence     = +(0.55 + Math.random() * 0.30).toFixed(3);
        break;
      case 'VEHICLE_CONVOY':
        anomalyBase    = 0.70 + Math.random() * 0.30;
        classification = Math.random() < 0.7 ? 'METAL' : 'WIRE';
        confidence     = +(0.75 + Math.random() * 0.22).toFixed(3);
        break;
      case 'INTRUSION':
        anomalyBase    = 0.30 + Math.random() * 0.50;
        classification = Math.random() < 0.5 ? 'METAL' : 'WIRE';
        confidence     = +(0.55 + Math.random() * 0.30).toFixed(3);
        break;
      default:
        anomalyBase    = Math.random() * 0.15;
        classification = 'CLEAR';
        confidence     = +(0.20 + Math.random() * 0.30).toFixed(3);
        break;
    }

    const inductance_anomaly = +this.clamp(
      anomalyBase + this.gaussian(0.03), 0, 1
    ).toFixed(4);

    // 32-float buried-object signature (Gaussian shape if anomaly)
    const buried_object_signature = Array.from({ length: 32 }, (_, i) => {
      const base = classification !== 'CLEAR'
        ? inductance_anomaly * Math.exp(-0.05 * (i - 16) ** 2)
        : 0;
      return +Math.max(0, base + this.gaussian(0.02)).toFixed(4);
    });

    return { inductance_anomaly, buried_object_signature, classification, confidence };
  }

  // ── Main generate ─────────────────────────────────────────────────────────

  generate() {
    const scenario = scenarioManager.getScenario();
    let rawValue;

    switch (this.modality) {
      case 'MAD':          rawValue = this.#buildMad(scenario);          break;
      case 'MAGNETOMETER': rawValue = this.#buildMagnetometer(scenario); break;
      case 'EMI':          rawValue = this.#buildEmi(scenario);          break;
      default:
        rawValue = { error: `Unknown magnetic modality: ${this.modality}` };
    }

    const isAlert =
      (this.modality === 'MAD'          && rawValue.anomaly_flag) ||
      (this.modality === 'MAGNETOMETER' && rawValue.metal_mass_kg_equiv > 10) ||
      (this.modality === 'EMI'          && rawValue.inductance_anomaly > 0.50);

    const processed = isAlert
      ? { event_detected: true, alert_priority: rawValue.confidence > 0.75 ? 'HIGH' : 'MEDIUM' }
      : { event_detected: false };

    return { rawValue, processed };
  }
}
