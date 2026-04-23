/**
 * base.js
 * Base generator class. All sensor generators extend this.
 *
 * Features:
 *   - Gaussian noise (Box-Muller) with configurable sigma
 *   - Random dropouts: sensor goes OFFLINE for 1-5 readings
 *   - Slow drift over time (sinusoidal baseline shift)
 *   - quality_score calculation based on effective noise level
 *   - Auto-registers with sensorRegistry and reports readings for REST history
 */

import { v4 as uuidv4 } from 'uuid';
import { faker } from '@faker-js/faker';
import { scenarioManager } from '../scenarioManager.js';
import { correlator } from '../correlator.js';
import { registerSensor, updateSensorReading } from '../restServer.js';
import { config as appConfig } from '../index.js';
import { logger } from '../logger.js';

const STATUSES = ['ONLINE', 'ONLINE', 'ONLINE', 'ONLINE', 'DEGRADED', 'MAINTENANCE'];

export class BaseGenerator {
  #intervalId = null;
  #dropoutRemaining = 0;
  #driftPhase = Math.random() * Math.PI * 2;
  #ticks = 0;

  /**
   * @param {object} opts
   * @param {string} opts.sensorId
   * @param {string} opts.modality
   * @param {number} opts.intervalMs
   * @param {object} opts.site  - { site_id, bop_id, lat, lon }
   * @param {number} [opts.noiseSigma=0.02]
   * @param {string} [opts.firmwareVer='1.2.3']
   * @param {number} [opts.updateRateHz]
   */
  constructor(opts) {
    this.sensorId    = opts.sensorId;
    this.modality    = opts.modality;
    this.intervalMs  = opts.intervalMs;
    this.site        = opts.site;
    this.noiseSigma  = opts.noiseSigma ?? appConfig?.noise?.seismic_sigma ?? 0.02;
    this.firmwareVer = opts.firmwareVer ?? '1.2.3';
    this.updateRateHz = opts.updateRateHz ?? +(1000 / opts.intervalMs).toFixed(2);

    // Register with REST layer
    registerSensor(this.sensorId, {
      modality:       this.modality,
      site_id:        this.site.site_id,
      bop_id:         this.site.bop_id,
      update_rate_hz: this.updateRateHz
    });
  }

  /** Gaussian noise via Box-Muller transform */
  gaussian(sigma = this.noiseSigma) {
    const u = 1 - Math.random();
    const v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
  }

  /** Clamp value to [min, max] */
  clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  /** Slow sinusoidal drift */
  getDrift(amplitude = 0.05) {
    return amplitude * Math.sin(this.#driftPhase + this.#ticks * 0.001);
  }

  /** Compute quality_score: high noise → lower score */
  computeQuality(noiseMagnitude = 0) {
    const base = 0.95;
    const degraded = scenarioManager.getScenario() !== 'NORMAL' ? 0.05 : 0;
    return +this.clamp(base - noiseMagnitude * 10 - degraded + this.gaussian(0.02), 0.3, 1.0).toFixed(3);
  }

  /** Pick a sensor status, weighted toward ONLINE */
  getSensorStatus() {
    if (this.#dropoutRemaining > 0) return 'OFFLINE';
    const r = Math.random();
    if (r < appConfig?.dropout_rate ?? 0.02) {
      this.#dropoutRemaining = 1 + Math.floor(Math.random() * 5);
      return 'OFFLINE';
    }
    // Small chance DEGRADED
    if (r < 0.05) return 'DEGRADED';
    return 'ONLINE';
  }

  /** Build the base payload wrapper */
  buildBase(rawValue, processed = null) {
    if (this.#dropoutRemaining > 0) this.#dropoutRemaining--;
    this.#ticks++;

    const status = this.getSensorStatus();
    const noiseLevel = Math.abs(this.gaussian(this.noiseSigma));

    const payload = {
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
      firmware_ver:  this.firmwareVer
    };

    if (processed) payload.processed = processed;

    return payload;
  }

  /**
   * Override in subclass to produce raw_value + optional processed.
   * Must return { rawValue, processed? }
   */
  generate() {
    throw new Error(`${this.constructor.name}.generate() not implemented`);
  }

  /** Start the generator loop */
  start(wsServer) {
    this.wsServer = wsServer;
    this.#intervalId = setInterval(() => {
      try {
        const { rawValue, processed } = this.generate();
        const payload = this.buildBase(rawValue, processed);

        // Publish to WebSocket
        wsServer.broadcast({ type: 'SENSOR_DATA', payload });

        // Feed correlator
        correlator.ingest(payload);

        // Update REST sensor registry
        updateSensorReading(this.sensorId, payload);
      } catch (err) {
        logger.error({ sensorId: this.sensorId, err: err.message }, `${this.constructor.name} tick error`);
      }
    }, this.intervalMs);

    logger.info({ sensorId: this.sensorId, intervalMs: this.intervalMs }, `${this.constructor.name} started`);
  }

  stop() {
    if (this.#intervalId) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }
  }
}
