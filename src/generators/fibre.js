/**
 * fibre.js
 * Covers S05 Fibre Optic Distributed Sensor — 50 Hz (20ms).
 *
 * raw_value schema:
 *   zone_id            – ZONE-A through ZONE-D
 *   distance_m         – 0-5000 along the fibre
 *   event_type         – NONE|FOOTSTEP|VEHICLE|CUT_ATTEMPT|VIBRATION
 *   signal_loss_db     – 0-3 normal, >5 alert
 *   intrusion_detected – bool
 *   event_confidence   – 0-1
 */

import { BaseGenerator } from './base.js';
import scenarioManager from '../scenarioManager.js';

const ZONES        = ['ZONE-A', 'ZONE-B', 'ZONE-C', 'ZONE-D'];
const EVENT_TYPES  = ['NONE', 'FOOTSTEP', 'VEHICLE', 'CUT_ATTEMPT', 'VIBRATION'];

// Persist active event distance so intrusions feel coherent across ticks
let _activeDistance = null;
let _activeZone     = null;

export default class FibreGenerator extends BaseGenerator {
  constructor(opts) {
    super({ noiseSigma: 0.01, ...opts });
  }

  generate() {
    const scenario = scenarioManager.getScenario();

    let event_type, signal_loss_db, intrusion_detected, event_confidence;

    switch (scenario) {
      case 'INTRUSION': {
        const isCut     = Math.random() < 0.15;
        event_type      = isCut ? 'CUT_ATTEMPT' : 'FOOTSTEP';
        signal_loss_db  = +(isCut
          ? 5 + Math.random() * 5          // CUT: 5-10 dB loss
          : 1 + Math.random() * 2          // FOOTSTEP: 1-3 dB
        ).toFixed(3);
        intrusion_detected = true;
        event_confidence   = +(0.80 + Math.random() * 0.15).toFixed(3);
        // Anchor to a stable location
        if (!_activeDistance) {
          _activeDistance = +(Math.random() * 5000).toFixed(1);
          _activeZone     = ZONES[Math.floor(Math.random() * ZONES.length)];
        }
        break;
      }

      case 'VEHICLE_CONVOY': {
        event_type         = 'VEHICLE';
        signal_loss_db     = +(2.5 + Math.random() * 4).toFixed(3);   // 2.5-6.5 dB
        intrusion_detected = true;
        event_confidence   = +(0.75 + Math.random() * 0.20).toFixed(3);
        if (!_activeDistance) {
          _activeDistance = +(Math.random() * 5000).toFixed(1);
          _activeZone     = ZONES[Math.floor(Math.random() * ZONES.length)];
        }
        break;
      }

      case 'ELEVATED': {
        if (Math.random() < 0.25) {
          event_type         = 'VIBRATION';
          signal_loss_db     = +(0.5 + Math.random() * 2).toFixed(3);
          intrusion_detected = Math.random() < 0.30;
          event_confidence   = +(0.40 + Math.random() * 0.35).toFixed(3);
        } else {
          event_type         = 'NONE';
          signal_loss_db     = +(Math.random() * 1.5 + this.gaussian(0.1)).toFixed(3);
          intrusion_detected = false;
          event_confidence   = +(0.20 + Math.random() * 0.25).toFixed(3);
        }
        _activeDistance = null;
        _activeZone     = null;
        break;
      }

      default: // NORMAL / DRONE / TUNNEL (fibre-transparent)
        event_type         = 'NONE';
        signal_loss_db     = +Math.max(0, Math.random() * 1.0 + this.gaussian(0.05)).toFixed(3);
        intrusion_detected = false;
        event_confidence   = +(0.10 + Math.random() * 0.20).toFixed(3);
        _activeDistance    = null;
        _activeZone        = null;
        break;
    }

    signal_loss_db = +Math.max(0, signal_loss_db + this.gaussian(0.02)).toFixed(3);

    const zone_id    = _activeZone     ?? ZONES[Math.floor(Math.random() * ZONES.length)];
    const distance_m = _activeDistance ?? +(Math.random() * 5000).toFixed(1);

    const rawValue = {
      zone_id,
      distance_m,
      event_type,
      signal_loss_db,
      intrusion_detected,
      event_confidence
    };

    const processed = intrusion_detected
      ? {
          event_detected: true,
          classification: event_type,
          alert_priority: event_type === 'CUT_ATTEMPT' ? 'HIGH'
            : signal_loss_db > 5 ? 'HIGH' : 'MEDIUM'
        }
      : { event_detected: false };

    return { rawValue, processed };
  }
}
