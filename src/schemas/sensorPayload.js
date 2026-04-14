/**
 * sensorPayload.js
 * Ajv-compatible JSON Schema for the base sensor payload envelope.
 *
 * Usage (optional validation, not on hot path):
 *   import Ajv from 'ajv';
 *   import { sensorPayloadSchema } from './schemas/sensorPayload.js';
 *   const ajv = new Ajv();
 *   const validate = ajv.compile(sensorPayloadSchema);
 *   const valid = validate(payload);
 *
 * Sub-schemas for each modality's raw_value are exported separately
 * for documentation / offline validation purposes.
 */

// ── Detection sub-schema (optical / AIML) ────────────────────────────────────

export const detectionSchema = {
  type: 'object',
  required: ['bbox', 'class', 'confidence', 'track_id'],
  properties: {
    bbox:       { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
    class:      { type: 'string', enum: ['HUMAN', 'VEHICLE', 'ANIMAL', 'UNKNOWN'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    track_id:   { type: 'string' }
  },
  additionalProperties: false
};

// ── GMTI Track sub-schema ────────────────────────────────────────────────────

export const gmtiTrackSchema = {
  type: 'object',
  required: ['track_id', 'lat', 'lon', 'range_m', 'velocity', 'heading', 'class', 'confidence', 'age_frames'],
  properties: {
    track_id:   { type: 'string' },
    lat:        { type: 'number', minimum: -90,  maximum: 90  },
    lon:        { type: 'number', minimum: -180, maximum: 180 },
    range_m:    { type: 'number', minimum: 0 },
    velocity:   { type: 'number' },
    heading:    { type: 'number', minimum: 0, maximum: 360 },
    class:      { type: 'string', enum: ['HUMAN', 'VEHICLE', 'ANIMAL', 'UNKNOWN'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    age_frames: { type: 'integer', minimum: 0 }
  },
  additionalProperties: false
};

// ── Base payload envelope schema ─────────────────────────────────────────────

export const sensorPayloadSchema = {
  $schema:    'http://json-schema.org/draft-07/schema#',
  $id:        'iinvsys/sensorPayload',
  title:      'IINVSYS Sensor Payload Envelope',
  description:'Base envelope emitted by all sensor generators on the SENSOR_DATA WebSocket event.',
  type:       'object',
  required: [
    'sensor_id', 'modality', 'timestamp', 'site_id', 'bop_id',
    'site_lat', 'site_lon', 'quality_score', 'raw_value',
    'sensor_status', 'firmware_ver'
  ],
  properties: {
    sensor_id:     { type: 'string', description: 'Unique sensor identifier, e.g. S03-ACU-001' },
    modality:      {
      type: 'string',
      description: 'Sensor modality type',
      enum: [
        'SEISMIC', 'VIBRATION',
        'ACOUSTIC',
        'EOTS', 'THERMAL', 'PTZ', 'CCTV', 'PIR', 'THERMAL_NV', 'NIR',
        'GPR', 'MICROWAVE', 'LIDAR', 'MMWAVE', 'GMTI',
        'MAD', 'MAGNETOMETER', 'EMI',
        'CHEMICAL',
        'FIBRE_OPTIC'
      ]
    },
    timestamp:     { type: 'string', format: 'date-time', description: 'ISO-8601 UTC timestamp' },
    site_id:       { type: 'string' },
    bop_id:        { type: 'string' },
    site_lat:      { type: 'number', minimum: -90,  maximum: 90  },
    site_lon:      { type: 'number', minimum: -180, maximum: 180 },
    quality_score: { type: 'number', minimum: 0, maximum: 1, description: 'Data quality 0-1' },
    sensor_status: { type: 'string', enum: ['ONLINE', 'DEGRADED', 'OFFLINE', 'MAINTENANCE'] },
    firmware_ver:  { type: 'string' },
    raw_value:     {
      type: 'object',
      description: 'Modality-specific raw sensor data. Structure varies by modality.'
    },
    processed: {
      type: 'object',
      description: 'Optional AIML-processed output',
      properties: {
        event_detected: { type: 'boolean' },
        classification: { type: 'string' },
        confidence:     { type: 'number', minimum: 0, maximum: 1 },
        alert_priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] }
      },
      additionalProperties: true
    }
  },
  additionalProperties: false
};

// ── Per-modality raw_value schemas (documentation only) ──────────────────────

export const rawValueSchemas = {

  SEISMIC: {
    type: 'object',
    properties: {
      pgv:            { type: 'number', description: 'Peak ground velocity mm/s' },
      rms:            { type: 'number' },
      dominant_freq:  { type: 'number', description: 'Hz' },
      waveform:       { type: 'array', items: { type: 'number' }, minItems: 100, maxItems: 100 },
      fft_magnitude:  { type: 'array', items: { type: 'number' }, minItems: 64,  maxItems: 64  },
      classification: { type: 'string', enum: ['HUMAN_FOOTFALL', 'VEHICLE', 'ANIMAL', 'MACHINERY', 'NOISE'] },
      confidence:     { type: 'number', minimum: 0, maximum: 1 }
    }
  },

  ACOUSTIC: {
    type: 'object',
    properties: {
      spl_db:            { type: 'number', description: '30-65 dB normal, >85 dB alert' },
      angle_of_arrival:  { type: 'number', minimum: 0, maximum: 360 },
      classification:    { type: 'string', enum: ['GUNSHOT','VEHICLE','HUMAN_VOICE','ANIMAL','MACHINERY','EXPLOSION','AMBIENT'] },
      confidence:        { type: 'number', minimum: 0, maximum: 1 },
      frequency_profile: { type: 'array', items: { type: 'number' }, minItems: 128, maxItems: 128 },
      event_duration_ms: { type: 'integer', minimum: 0 }
    }
  },

  OPTICAL: {
    type: 'object',
    description: 'Applies to EOTS, THERMAL, PTZ, CCTV, THERMAL_NV, NIR modalities',
    properties: {
      frame_jpeg_b64: { type: 'string', description: 'Base64-encoded JPEG frame' },
      detections:     { type: 'array', items: detectionSchema },
      frame_width:    { type: 'integer', const: 1920 },
      frame_height:   { type: 'integer', const: 1080 },
      ptz_pan:        { type: 'number', minimum: 0,   maximum: 360, description: 'PTZ/EOTS only' },
      ptz_tilt:       { type: 'number', minimum: -90, maximum: 90,  description: 'PTZ/EOTS only' },
      ptz_zoom:       { type: 'number', minimum: 1.0, maximum: 30.0 }
    }
  },

  PIR: {
    type: 'object',
    properties: {
      motion_detected: { type: 'boolean' },
      zone_id:         { type: 'string' },
      timestamp:       { type: 'string', format: 'date-time' }
    }
  },

  GPR: {
    type: 'object',
    properties: {
      depth_m:             { type: 'number', minimum: 0, maximum: 5 },
      scan_distance_m:     { type: 'number', minimum: 0 },
      anomaly_detected:    { type: 'boolean' },
      anomaly_confidence:  { type: 'number', minimum: 0, maximum: 1 },
      hyperbola_amplitude: { type: 'number', description: 'dB' },
      classification:      { type: 'string', enum: ['TUNNEL','CABLE','ROCK','CLEAR'] },
      b_scan_row:          { type: 'array', items: { type: 'number' }, minItems: 128, maxItems: 128 }
    }
  },

  MICROWAVE: {
    type: 'object',
    properties: {
      zone_breached:       { type: 'boolean' },
      breach_count:        { type: 'integer', minimum: 0 },
      zone_id:             { type: 'string' },
      signal_strength_dbm: { type: 'number' }
    }
  },

  LIDAR: {
    type: 'object',
    properties: {
      point_count:         { type: 'integer', minimum: 0 },
      objects_detected:    { type: 'integer', minimum: 0 },
      nearest_object_m:    { type: 'number',  minimum: 0 },
      point_cloud_summary: {
        type: 'object',
        properties: {
          min_x: { type: 'number' }, max_x: { type: 'number' },
          min_y: { type: 'number' }, max_y: { type: 'number' },
          min_z: { type: 'number' }, max_z: { type: 'number' }
        }
      }
    }
  },

  MMWAVE: {
    type: 'object',
    properties: {
      detections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            range_m:      { type: 'number' },
            azimuth_deg:  { type: 'number' },
            velocity_mps: { type: 'number' },
            rcs_dbsm:     { type: 'number' }
          }
        }
      },
      visibility_m: { type: 'number', minimum: 200, maximum: 5000 }
    }
  },

  GMTI: {
    type: 'object',
    properties: {
      tracks:            { type: 'array', items: gmtiTrackSchema },
      range_doppler_map: { type: 'array', items: { type: 'number' }, minItems: 64, maxItems: 64 },
      coverage_az_deg:   { type: 'number', minimum: 0, maximum: 360 },
      max_range_m:       { type: 'number', minimum: 0 }
    }
  },

  MAD: {
    type: 'object',
    properties: {
      field_delta_nt:  { type: 'number', description: 'background ±50 nT, alert >200 nT' },
      anomaly_flag:    { type: 'boolean' },
      baseline_nt:     { type: 'number' },
      confidence:      { type: 'number', minimum: 0, maximum: 1 }
    }
  },

  MAGNETOMETER: {
    type: 'object',
    properties: {
      metal_mass_kg_equiv: { type: 'number', minimum: 0, description: '0-5 normal, >10 alert' },
      confidence:          { type: 'number', minimum: 0, maximum: 1 },
      field_x_nt:          { type: 'number' },
      field_y_nt:          { type: 'number' },
      field_z_nt:          { type: 'number' }
    }
  },

  EMI: {
    type: 'object',
    properties: {
      inductance_anomaly:      { type: 'number', minimum: 0, maximum: 1 },
      buried_object_signature: { type: 'array', items: { type: 'number' }, minItems: 32, maxItems: 32 },
      classification:          { type: 'string', enum: ['METAL', 'WIRE', 'CLEAR'] },
      confidence:              { type: 'number', minimum: 0, maximum: 1 }
    }
  },

  CHEMICAL: {
    type: 'object',
    properties: {
      compound_id:        { type: 'string', enum: ['RDX', 'TNT', 'PETN', 'NH4NO3', 'NONE'] },
      concentration_ppb:  { type: 'number', minimum: 0, description: '<0.5 baseline, >10 alert' },
      alarm:              { type: 'boolean' },
      detector_temp_c:    { type: 'number' },
      compounds: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            compound_id:       { type: 'string' },
            concentration_ppb: { type: 'number', minimum: 0 }
          }
        }
      }
    }
  },

  FIBRE_OPTIC: {
    type: 'object',
    properties: {
      zone_id:            { type: 'string', enum: ['ZONE-A', 'ZONE-B', 'ZONE-C', 'ZONE-D'] },
      distance_m:         { type: 'number', minimum: 0, maximum: 5000 },
      event_type:         { type: 'string', enum: ['NONE', 'FOOTSTEP', 'VEHICLE', 'CUT_ATTEMPT', 'VIBRATION'] },
      signal_loss_db:     { type: 'number', minimum: 0, description: '0-3 normal, >5 alert' },
      intrusion_detected: { type: 'boolean' },
      event_confidence:   { type: 'number', minimum: 0, maximum: 1 }
    }
  }
};

// Default export for convenience
export default sensorPayloadSchema;
