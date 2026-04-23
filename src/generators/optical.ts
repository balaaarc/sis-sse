import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { BaseGenerator } from './base.js';
import { scenarioManager } from '../scenarioManager.js';
import type { GeneratorOpts, GenerateResult } from '../types.js';

const FRAME_W = 320;
const FRAME_H = 180;

interface RgbColor { r: number; g: number; b: number }

const MODALITY_BASE_COLOR: Record<string, RgbColor> = {
  EOTS:        { r: 15,  g: 110, b: 20  },
  THERMAL:     { r: 160, g: 65,  b: 15  },
  PTZ:         { r: 45,  g: 75,  b: 145 },
  CCTV:        { r: 60,  g: 60,  b: 75  },
  THERMAL_NV:  { r: 45,  g: 25,  b: 110 },
  NIR_VISIBLE: { r: 15,  g: 90,  b: 30  },
  PIR_IR:      { r: 180, g: 40,  b: 10  },
};

async function generateSyntheticFrame(modality: string, tick: number): Promise<string> {
  const base = MODALITY_BASE_COLOR[modality] ?? { r: 20, g: 20, b: 25 };
  const shimmer = Math.sin(tick * 0.18) * 12;
  const r = Math.max(0, Math.min(255, base.r + shimmer + (Math.random() - 0.5) * 10));
  const g = Math.max(0, Math.min(255, base.g + shimmer + (Math.random() - 0.5) * 10));
  const b = Math.max(0, Math.min(255, base.b + shimmer + (Math.random() - 0.5) * 10));

  const pixels = Buffer.alloc(FRAME_W * FRAME_H * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    const noise = (Math.random() - 0.5) * 18;
    pixels[i]     = Math.max(0, Math.min(255, r + noise));
    pixels[i + 1] = Math.max(0, Math.min(255, g + noise));
    pixels[i + 2] = Math.max(0, Math.min(255, b + noise));
  }

  const buf = await sharp(pixels, {
    raw: { width: FRAME_W, height: FRAME_H, channels: 3 },
  }).jpeg({ quality: 45 }).toBuffer();

  return buf.toString('base64');
}

const PIR_ZONES = ['ZONE-A', 'ZONE-B', 'ZONE-C', 'ZONE-D'] as const;
const trackRegistry = new Map<string, string>();

function getOrCreateTrackId(key: string): string {
  if (!trackRegistry.has(key)) trackRegistry.set(key, uuidv4());
  return trackRegistry.get(key)!;
}

function clearTrack(key: string): void {
  trackRegistry.delete(key);
}

interface Detection {
  bbox:       [number, number, number, number];
  class:      string;
  confidence: number;
  track_id:   string;
}

export class OpticalGenerator extends BaseGenerator {
  #ptzPan   = Math.random() * 360;
  #ptzTilt  = (Math.random() - 0.5) * 90;
  #ptzZoom  = 1.0 + Math.random() * 3;
  #frameB64: string | null = null;
  #frameTick = 0;
  #frameTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: GeneratorOpts) {
    super({ noiseSigma: 0.01, ...opts });
    if (this.modality !== 'PIR_IR') this.#startFrameLoop();
  }

  #startFrameLoop(): void {
    const generate = async () => {
      try {
        this.#frameB64 = await generateSyntheticFrame(this.modality, this.#frameTick++);
      } catch {
        // keep previous frame on error
      }
    };
    void generate();
    this.#frameTimer = setInterval(() => void generate(), 200);
  }

  destroy(): void {
    if (this.#frameTimer) {
      clearInterval(this.#frameTimer);
      this.#frameTimer = null;
    }
  }

  #makeDetection(cls: string, confMin: number, confMax: number, yMax = 0.9, small = false): Detection {
    const w = small ? 0.02 + Math.random() * 0.04 : 0.05 + Math.random() * 0.10;
    const h = small ? 0.02 + Math.random() * 0.04 : 0.08 + Math.random() * 0.15;
    const x = Math.random() * (1 - w);
    const y = Math.random() * (yMax - h);
    const confidence = +(confMin + Math.random() * (confMax - confMin)).toFixed(3);
    return {
      bbox:       [+x.toFixed(4), +y.toFixed(4), +w.toFixed(4), +h.toFixed(4)],
      class:      cls,
      confidence,
      track_id:   getOrCreateTrackId(`${this.sensorId}-${cls}-${Math.floor(x * 5)}`),
    };
  }

  #buildPirPayload(scenario: string): Record<string, unknown> {
    const motion_detected =
      scenario === 'INTRUSION' ||
      scenario === 'VEHICLE_CONVOY' ||
      (scenario === 'ELEVATED'    && Math.random() < 0.4) ||
      (scenario === 'NORMAL'      && Math.random() < 0.03);

    return {
      motion_detected,
      zone_id:   PIR_ZONES[Math.floor(Math.random() * PIR_ZONES.length)],
      timestamp: new Date().toISOString(),
    };
  }

  #tickPtz(): void {
    this.#ptzPan  = (this.#ptzPan  + (Math.random() - 0.5) * 0.5 + 360) % 360;
    this.#ptzTilt = this.clamp(this.#ptzTilt + (Math.random() - 0.5) * 0.2, -90, 90);
  }

  generate(): GenerateResult {
    const scenario = scenarioManager.getScenario();
    const isPir    = this.modality === 'PIR_IR';
    const hasPtz   = this.modality === 'PTZ' || this.modality === 'EOTS';

    if (isPir) {
      const rawValue = this.#buildPirPayload(scenario);
      const processed = (rawValue.motion_detected as boolean)
        ? { event_detected: true, classification: 'MOTION', alert_priority: 'MEDIUM' }
        : { event_detected: false };
      return { rawValue, processed };
    }

    if (hasPtz) this.#tickPtz();

    const detections: Detection[] = [];

    switch (scenario) {
      case 'INTRUSION': {
        const count = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < count; i++) detections.push(this.#makeDetection('HUMAN', 0.75, 0.95));
        break;
      }
      case 'DRONE':
        detections.push(this.#makeDetection('UNKNOWN', 0.60, 0.85, 0.30, true));
        break;
      case 'VEHICLE_CONVOY': {
        const count = 2 + Math.floor(Math.random() * 4);
        for (let i = 0; i < count; i++) detections.push(this.#makeDetection('VEHICLE', 0.85, 0.98));
        break;
      }
      case 'ELEVATED':
        if (Math.random() < 0.30)      detections.push(this.#makeDetection('HUMAN',  0.40, 0.70));
        else if (Math.random() < 0.20) detections.push(this.#makeDetection('ANIMAL', 0.35, 0.65));
        break;
      default:
        if (Math.random() < 0.05) detections.push(this.#makeDetection('ANIMAL', 0.30, 0.60));
        break;
    }

    if (detections.length === 0) {
      for (const key of [...trackRegistry.keys()]) {
        if (key.startsWith(this.sensorId)) clearTrack(key);
      }
    }

    const rawValue: Record<string, unknown> = {
      frame_jpeg_b64: this.#frameB64 ?? '',
      detections,
      frame_width:    FRAME_W,
      frame_height:   FRAME_H,
      ...(hasPtz && {
        ptz_pan:  +this.#ptzPan.toFixed(2),
        ptz_tilt: +this.#ptzTilt.toFixed(2),
        ptz_zoom: +this.clamp(this.#ptzZoom + this.gaussian(0.1), 1.0, 30.0).toFixed(2),
      }),
    };

    const hasAlert = detections.some((d) => d.class === 'HUMAN' && d.confidence > 0.75);
    const processed = detections.length > 0
      ? {
          event_detected:  true,
          detection_count: detections.length,
          primary_class:   detections[0].class,
          alert_priority:  hasAlert ? 'HIGH' : 'MEDIUM',
        }
      : { event_detected: false };

    return { rawValue, processed };
  }
}
