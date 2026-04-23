/**
 * optical.js
 * Covers S06 EOTS, S07 THERMAL, S08 PTZ, S10 CCTV, S12 PIR_IR,
 * S15 THERMAL_NV, S16 NIR_VISIBLE.
 *
 * Update rates:
 *   Most optical sensors – 25 fps (40ms)
 *   PIR                  – 10 Hz (100ms)
 *
 * raw_value schema (non-PIR):
 *   frame_jpeg_b64 – 1x1 placeholder JPEG (base64)
 *   detections     – Detection[]
 *   frame_width    – 1920
 *   frame_height   – 1080
 *   ptz_pan        – 0-360 (PTZ/EOTS only)
 *   ptz_tilt       – -90 to 90 (PTZ/EOTS only)
 *   ptz_zoom       – 1.0-30.0
 *
 * Detection: { bbox: [x,y,w,h], class, confidence, track_id }
 *
 * PIR raw_value:
 *   { motion_detected: bool, zone_id: string, timestamp: string }
 */

import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { BaseGenerator } from './base.js';
import { scenarioManager } from '../scenarioManager.js';

// Frame dimensions for synthetic video
const FRAME_W = 320;
const FRAME_H = 180;

// Per-modality base color (BGR-style tint for each sensor type)
const MODALITY_BASE_COLOR = {
  EOTS:       { r: 15,  g: 110, b: 20  },  // green NV
  THERMAL:    { r: 160, g: 65,  b: 15  },  // amber thermal
  PTZ:        { r: 45,  g: 75,  b: 145 },  // navy daylight (brighter)
  CCTV:       { r: 60,  g: 60,  b: 75  },  // dark grey (brighter)
  THERMAL_NV: { r: 45,  g: 25,  b: 110 },  // purple NV (brighter)
  NIR_VISIBLE: { r: 15,  g: 90,  b: 30  },
  PIR_IR:      { r: 180, g: 40,  b: 10  },  // bright green NIR
};

// Generate a synthetic noise frame asynchronously
async function generateSyntheticFrame(modality, tick) {
  const base = MODALITY_BASE_COLOR[modality] ?? { r: 20, g: 20, b: 25 };
  // Add slow time-varying shimmer
  const shimmer = Math.sin(tick * 0.18) * 12;
  const r = Math.max(0, Math.min(255, base.r + shimmer + (Math.random() - 0.5) * 10));
  const g = Math.max(0, Math.min(255, base.g + shimmer + (Math.random() - 0.5) * 10));
  const b = Math.max(0, Math.min(255, base.b + shimmer + (Math.random() - 0.5) * 10));

  // Build raw RGB noise buffer for a more realistic look
  const pixels = Buffer.alloc(FRAME_W * FRAME_H * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    const noise = (Math.random() - 0.5) * 18;
    pixels[i]     = Math.max(0, Math.min(255, r + noise));
    pixels[i + 1] = Math.max(0, Math.min(255, g + noise));
    pixels[i + 2] = Math.max(0, Math.min(255, b + noise));
  }

  const buf = await sharp(pixels, {
    raw: { width: FRAME_W, height: FRAME_H, channels: 3 }
  }).jpeg({ quality: 45 }).toBuffer();

  return buf.toString('base64');
}

const PIR_ZONES = ['ZONE-A', 'ZONE-B', 'ZONE-C', 'ZONE-D'];

// Persistent track registry (track_id survives across ticks for realism)
const trackRegistry = new Map();

function getOrCreateTrackId(key) {
  if (!trackRegistry.has(key)) {
    trackRegistry.set(key, uuidv4());
  }
  return trackRegistry.get(key);
}

function clearTrack(key) {
  trackRegistry.delete(key);
}

export class OpticalGenerator extends BaseGenerator {
  #ptzPan  = Math.random() * 360;
  #ptzTilt = (Math.random() - 0.5) * 90;
  #ptzZoom = 1.0 + Math.random() * 3;
  #frameB64 = null;
  #frameTick = 0;
  #frameTimer = null;

  constructor(opts) {
    super({ noiseSigma: 0.01, ...opts });
    // Start async frame generation loop (200ms cadence, decoupled from sensor tick)
    if (this.modality !== 'PIR_IR') {
      this.#startFrameLoop()
    }
  }

  #startFrameLoop() {
    const generate = async () => {
      try {
        this.#frameB64 = await generateSyntheticFrame(this.modality, this.#frameTick++);
      } catch {
        // keep previous frame on error
      }
    };
    generate();
    this.#frameTimer = setInterval(generate, 200);
  }

  destroy() {
    if (this.#frameTimer) {
      clearInterval(this.#frameTimer);
      this.#frameTimer = null;
    }
  }

  /** Generate a random Detection bounding box */
  #makeDetection(cls, confMin, confMax, yMax = 0.9, small = false) {
    const w = small ? 0.02 + Math.random() * 0.04 : 0.05 + Math.random() * 0.10;
    const h = small ? 0.02 + Math.random() * 0.04 : 0.08 + Math.random() * 0.15;
    const x = Math.random() * (1 - w);
    const y = Math.random() * (yMax - h);
    const confidence = +(confMin + Math.random() * (confMax - confMin)).toFixed(3);
    return {
      bbox:       [+x.toFixed(4), +y.toFixed(4), +w.toFixed(4), +h.toFixed(4)],
      class:      cls,
      confidence,
      track_id:   getOrCreateTrackId(`${this.sensorId}-${cls}-${Math.floor(x * 5)}`)
    };
  }

  /** Build PIR raw_value */
  #buildPirPayload(scenario) {
    const motion_detected =
      scenario === 'INTRUSION' ||
      scenario === 'VEHICLE_CONVOY' ||
      (scenario === 'ELEVATED' && Math.random() < 0.4) ||
      (scenario === 'NORMAL' && Math.random() < 0.03);

    return {
      motion_detected,
      zone_id:   PIR_ZONES[Math.floor(Math.random() * PIR_ZONES.length)],
      timestamp: new Date().toISOString()
    };
  }

  /** Gently pan/tilt the PTZ mount each tick */
  #tickPtz() {
    this.#ptzPan  = (this.#ptzPan  + (Math.random() - 0.5) * 0.5 + 360) % 360;
    this.#ptzTilt = this.clamp(this.#ptzTilt + (Math.random() - 0.5) * 0.2, -90, 90);
  }

  generate() {
    const scenario = scenarioManager.getScenario();
    const isPir = this.modality === 'PIR_IR';
    const hasPtz = this.modality === 'PTZ' || this.modality === 'EOTS';

    // ── PIR path ──────────────────────────────────────────────────────────
    if (isPir) {
      const rawValue = this.#buildPirPayload(scenario);
      const processed = rawValue.motion_detected
        ? { event_detected: true, classification: 'MOTION', alert_priority: 'MEDIUM' }
        : { event_detected: false };
      return { rawValue, processed };
    }

    // ── PTZ tracking ──────────────────────────────────────────────────────
    if (hasPtz) this.#tickPtz();

    // ── Build detections based on scenario ────────────────────────────────
    let detections = [];

    switch (scenario) {
      case 'INTRUSION': {
        const count = 1 + Math.floor(Math.random() * 3);   // 1-3
        for (let i = 0; i < count; i++) {
          detections.push(this.#makeDetection('HUMAN', 0.75, 0.95));
        }
        break;
      }

      case 'DRONE': {
        // Small UNKNOWN target in upper third of frame
        detections.push(this.#makeDetection('UNKNOWN', 0.60, 0.85, 0.30, true));
        break;
      }

      case 'VEHICLE_CONVOY': {
        const count = 2 + Math.floor(Math.random() * 4);   // 2-5
        for (let i = 0; i < count; i++) {
          detections.push(this.#makeDetection('VEHICLE', 0.85, 0.98));
        }
        break;
      }

      case 'ELEVATED': {
        if (Math.random() < 0.30) {
          detections.push(this.#makeDetection('HUMAN', 0.40, 0.70));
        } else if (Math.random() < 0.20) {
          detections.push(this.#makeDetection('ANIMAL', 0.35, 0.65));
        }
        break;
      }

      default: // NORMAL
        // Rarely one animal detection
        if (Math.random() < 0.05) {
          detections.push(this.#makeDetection('ANIMAL', 0.30, 0.60));
        }
        break;
    }

    // Clear stale tracks for detections that vanish
    if (detections.length === 0) {
      for (const key of [...trackRegistry.keys()]) {
        if (key.startsWith(this.sensorId)) clearTrack(key);
      }
    }

    const rawValue = {
      frame_jpeg_b64: this.#frameB64 ?? '',
      detections,
      frame_width:    FRAME_W,
      frame_height:   FRAME_H,
      ...(hasPtz && {
        ptz_pan:  +this.#ptzPan.toFixed(2),
        ptz_tilt: +this.#ptzTilt.toFixed(2),
        ptz_zoom: +this.clamp(this.#ptzZoom + this.gaussian(0.1), 1.0, 30.0).toFixed(2)
      })
    };

    const hasAlert = detections.some(d => d.class === 'HUMAN' && d.confidence > 0.75);
    const processed = detections.length > 0
      ? {
          event_detected: true,
          detection_count: detections.length,
          primary_class:   detections[0].class,
          alert_priority:  hasAlert ? 'HIGH' : 'MEDIUM'
        }
      : { event_detected: false };

    return { rawValue, processed };
  }
}
