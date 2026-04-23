import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'http';

import { createWsServer } from './wsServer.js';
import { createRestServer } from './restServer.js';
import { scenarioManager } from './scenarioManager.js';
import { logger } from './logger.js';
import type { AppConfig, SiteConfig } from './types.js';

import { SeismicGenerator }   from './generators/seismic.js';
import { AcousticGenerator }  from './generators/acoustic.js';
import { OpticalGenerator }   from './generators/optical.js';
import { RadarGenerator }     from './generators/radar.js';
import { MagneticGenerator }  from './generators/magnetic.js';
import { ChemicalGenerator }  from './generators/chemical.js';
import { FibreGenerator }     from './generators/fibre.js';
import { AimlGenerator }      from './generators/aiml.js';
import { correlator }         from './correlator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, '..', 'config.json');
export const config: AppConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as AppConfig;

const PORT = parseInt(process.env.PORT ?? String(config.ws_port ?? 4000), 10);
const httpServer = http.createServer();

async function main(): Promise<void> {
  logger.info('Starting IINVSYS Sensor Simulation Engine...');

  scenarioManager.setScenario(config.default_scenario);

  const wsServer = createWsServer(config, httpServer);
  await createRestServer(config, wsServer, httpServer);

  const site: SiteConfig = config.sites[0];

  const generators = [
    new SeismicGenerator({ sensorId: 'S02-GEO-001', modality: 'SEISMIC',    intervalMs: 10,    site }),
    new SeismicGenerator({ sensorId: 'S09-VIB-001', modality: 'VIBRATION',  intervalMs: 10,    site }),
    new AcousticGenerator({ sensorId: 'S03-ACU-001', modality: 'ACOUSTIC',  intervalMs: 100,   site }),
    new FibreGenerator({ sensorId: 'S05-FIB-001',   modality: 'FIBRE_OPTIC', intervalMs: 20,   site }),
    new OpticalGenerator({ sensorId: 'S06-EOT-001', modality: 'EOTS',       intervalMs: 40,    site }),
    new OpticalGenerator({ sensorId: 'S07-THR-001', modality: 'THERMAL',    intervalMs: 40,    site }),
    new OpticalGenerator({ sensorId: 'S08-PTZ-001', modality: 'PTZ',        intervalMs: 40,    site }),
    new OpticalGenerator({ sensorId: 'S10-CCV-001', modality: 'CCTV',       intervalMs: 40,    site }),
    new OpticalGenerator({ sensorId: 'S12-PIR-001', modality: 'PIR_IR',     intervalMs: 100,   site }),
    new OpticalGenerator({ sensorId: 'S15-TNV-001', modality: 'THERMAL_NV', intervalMs: 40,    site }),
    new OpticalGenerator({ sensorId: 'S16-NIR-001', modality: 'NIR_VISIBLE',intervalMs: 40,    site }),
    new RadarGenerator({ sensorId: 'S01-GPR-001',   modality: 'GPR',        intervalMs: 10000, site }),
    new RadarGenerator({ sensorId: 'S11-MWB-001',   modality: 'MICROWAVE',  intervalMs: 100,   site }),
    new RadarGenerator({ sensorId: 'S13-LID-001',   modality: 'LIDAR',      intervalMs: 100,   site }),
    new RadarGenerator({ sensorId: 'S17-MMW-001',   modality: 'MMWAVE',     intervalMs: 100,   site }),
    new RadarGenerator({ sensorId: 'S18-GMT-001',   modality: 'GMTI_RADAR', intervalMs: 100,   site }),
    new MagneticGenerator({ sensorId: 'S04-MAD-001', modality: 'MAD',           intervalMs: 1000, site }),
    new MagneticGenerator({ sensorId: 'S14-MAG-001', modality: 'MAGNETOMETER',  intervalMs: 1000, site }),
    new MagneticGenerator({ sensorId: 'S19-EMI-001', modality: 'EMI',           intervalMs: 1000, site }),
    new ChemicalGenerator({ sensorId: 'S20-CHM-001', modality: 'CHEMICAL',      intervalMs: 5000, site }),
  ];

  correlator.on('correlated_event', (event: unknown) => {
    wsServer.broadcast({ type: 'AIML_ALERT', payload: event });
  });

  for (const gen of generators) gen.start(wsServer);

  const aiml = new AimlGenerator({ generators, site });
  aiml.start(wsServer);

  setInterval(() => {
    wsServer.broadcast({ type: 'SYSTEM_HEALTH', payload: buildSystemHealth(site) });
  }, 2000);

  await new Promise<void>((resolve) => httpServer.listen(PORT, '0.0.0.0', resolve));

  logger.info(`Server listening on port ${PORT} (WS + REST on single port)`);
  logger.info(`Active scenario: ${scenarioManager.getScenario()}`);
  logger.info('All generators started. SSE is running.');
}

function buildSystemHealth(site: SiteConfig): Record<string, unknown> {
  const jitter = (base: number, range: number) =>
    +(base + (Math.random() - 0.5) * range).toFixed(1);
  return {
    timestamp: new Date().toISOString(),
    node_id:   site.site_id,
    hardware: {
      cpu_percent:   jitter(45, 20),
      gpu_percent:   jitter(67, 15),
      ram_percent:   jitter(52, 10),
      nvme_percent:  jitter(23, 5),
      temperature_c: jitter(52, 8),
      uptime_hours:  +(process.uptime() / 3600).toFixed(2),
    },
    comms: {
      SATCOM:  { active: true,                signal_quality: jitter(0.87, 0.1)  },
      LTE:     { active: true,                signal_quality: jitter(0.92, 0.1)  },
      VHF_UHF: { active: Math.random() > 0.3, signal_quality: jitter(0.0,  0.4)  },
      LORA:    { active: true,                signal_quality: jitter(0.76, 0.15) },
      WIFI6:   { active: true,                signal_quality: jitter(0.95, 0.08) },
      BLE:     { active: true,                signal_quality: jitter(0.88, 0.1)  },
    },
    aiml: {
      inference_fps:      jitter(24.5, 3),
      gpu_memory_percent: jitter(71.2, 10),
      model_versions: {
        detection: 'yolov9-v1.2',
        tracking:  'bytetrack-v2.0',
        threat:    'bayesian-v3.1',
      },
    },
  };
}

main().catch((err: Error) => {
  logger.error(err, 'Fatal startup error');
  process.exit(1);
});
