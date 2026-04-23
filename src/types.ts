import type { WebSocketServer } from 'ws';

export type ScenarioName =
  | 'NORMAL'
  | 'ELEVATED'
  | 'INTRUSION'
  | 'TUNNEL_ACTIVITY'
  | 'DRONE'
  | 'VEHICLE_CONVOY';

export type SensorStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'MAINTENANCE';
export type ThreatLevel = 'CLEAR' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AlertPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface SiteConfig {
  site_id: string;
  bop_id: string;
  lat: number;
  lon: number;
}

export interface AppConfig {
  ws_port: number;
  rest_port: number;
  default_scenario: string;
  ring_buffer_seconds: number;
  noise: {
    seismic_sigma: number;
    acoustic_sigma: number;
    radar_sigma: number;
  };
  dropout_rate: number;
  sites: SiteConfig[];
  cors_origins: string[];
}

export interface BasePayload {
  sensor_id: string;
  modality: string;
  timestamp: string;
  site_id: string;
  bop_id: string;
  site_lat: number;
  site_lon: number;
  quality_score: number;
  raw_value: Record<string, unknown>;
  sensor_status: SensorStatus;
  firmware_ver: string;
  processed?: Record<string, unknown>;
}

export interface WsMessage {
  type: string;
  payload: unknown;
}

export interface AckDetail {
  alertId: string;
  user: string;
  comment: string;
  ack_time: string;
}

export interface IWsServer {
  wss: WebSocketServer;
  broadcast: (message: WsMessage) => void;
  getClientCount: () => number;
  getAcknowledgedAlerts: () => Map<string, AckDetail>;
  getRingBuffer: () => IRingBuffer;
}

export interface IRingBuffer {
  push: (sensorId: string, message: WsMessage) => void;
  getRecent: (sensorId: string) => WsMessage[];
  getAllRecent: () => WsMessage[];
}

export interface GeneratorOpts {
  sensorId: string;
  modality: string;
  intervalMs: number;
  site: SiteConfig;
  noiseSigma?: number;
  firmwareVer?: string;
  updateRateHz?: number;
}

export interface GenerateResult {
  rawValue: Record<string, unknown>;
  processed?: Record<string, unknown>;
}

export interface SensorMeta {
  modality: string;
  site_id: string;
  bop_id: string;
  update_rate_hz: number;
  last_seen: string | null;
  last_reading: BasePayload | null;
}

export interface AlertRecord {
  alert_id: string;
  [key: string]: unknown;
}
