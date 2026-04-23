import { scenarioManager } from '../scenarioManager.js';
import { correlator } from '../correlator.js';
import { registerSensor, updateSensorReading } from '../restServer.js';
import { config as appConfig } from '../index.js';
import { logger } from '../logger.js';
import type { GeneratorOpts, GenerateResult, BasePayload, SensorStatus, IWsServer } from '../types.js';

export class BaseGenerator {
  readonly sensorId: string;
  readonly modality: string;
  readonly intervalMs: number;
  readonly site: GeneratorOpts['site'];
  readonly noiseSigma: number;
  readonly firmwareVer: string;
  readonly updateRateHz: number;

  #intervalId: ReturnType<typeof setInterval> | null = null;
  #dropoutRemaining = 0;
  #driftPhase = Math.random() * Math.PI * 2;
  #ticks = 0;

  constructor(opts: GeneratorOpts) {
    this.sensorId     = opts.sensorId;
    this.modality     = opts.modality;
    this.intervalMs   = opts.intervalMs;
    this.site         = opts.site;
    this.noiseSigma   = opts.noiseSigma ?? appConfig?.noise?.seismic_sigma ?? 0.02;
    this.firmwareVer  = opts.firmwareVer ?? '1.2.3';
    this.updateRateHz = opts.updateRateHz ?? +(1000 / opts.intervalMs).toFixed(2);

    registerSensor(this.sensorId, {
      modality:       this.modality,
      site_id:        this.site.site_id,
      bop_id:         this.site.bop_id,
      update_rate_hz: this.updateRateHz,
    });
  }

  gaussian(sigma = this.noiseSigma): number {
    const u = 1 - Math.random();
    const v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
  }

  clamp(val: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, val));
  }

  getDrift(amplitude = 0.05): number {
    return amplitude * Math.sin(this.#driftPhase + this.#ticks * 0.001);
  }

  computeQuality(noiseMagnitude = 0): number {
    const base = 0.95;
    const degraded = scenarioManager.getScenario() !== 'NORMAL' ? 0.05 : 0;
    return +this.clamp(base - noiseMagnitude * 10 - degraded + this.gaussian(0.02), 0.3, 1.0).toFixed(3);
  }

  getSensorStatus(): SensorStatus {
    if (this.#dropoutRemaining > 0) return 'OFFLINE';
    const r = Math.random();
    const dropoutRate = appConfig?.dropout_rate ?? 0.02;
    if (r < dropoutRate) {
      this.#dropoutRemaining = 1 + Math.floor(Math.random() * 5);
      return 'OFFLINE';
    }
    if (r < 0.05) return 'DEGRADED';
    return 'ONLINE';
  }

  buildBase(rawValue: Record<string, unknown>, processed: Record<string, unknown> | null = null): BasePayload {
    if (this.#dropoutRemaining > 0) this.#dropoutRemaining--;
    this.#ticks++;

    const status = this.getSensorStatus();
    const noiseLevel = Math.abs(this.gaussian(this.noiseSigma));

    const payload: BasePayload = {
      sensor_id:     this.sensorId,
      modality:      this.modality,
      timestamp:     new Date().toISOString(),
      site_id:       this.site.site_id,
      bop_id:        this.site.bop_id,
      site_lat:      this.site.lat,
      site_lon:      this.site.lon,
      quality_score: this.computeQuality(noiseLevel),
      raw_value:     rawValue,
      sensor_status: status,
      firmware_ver:  this.firmwareVer,
    };

    if (processed) payload.processed = processed;

    return payload;
  }

  generate(): GenerateResult {
    throw new Error(`${this.constructor.name}.generate() not implemented`);
  }

  start(wsServer: IWsServer): void {
    this.#intervalId = setInterval(() => {
      try {
        const { rawValue, processed } = this.generate();
        const payload = this.buildBase(rawValue, processed ?? null);

        wsServer.broadcast({ type: 'SENSOR_DATA', payload });
        correlator.ingest(payload);
        updateSensorReading(this.sensorId, payload);
      } catch (err) {
        logger.error({ sensorId: this.sensorId, err: (err as Error).message }, `${this.constructor.name} tick error`);
      }
    }, this.intervalMs);

    logger.info({ sensorId: this.sensorId, intervalMs: this.intervalMs }, `${this.constructor.name} started`);
  }

  stop(): void {
    if (this.#intervalId) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }
  }
}
