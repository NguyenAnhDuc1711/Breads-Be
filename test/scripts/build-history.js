
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(__dirname, '..', 'results');
const csvPath = path.join(resultsDir, 'history.csv');

const columns = [
  'timestamp',
  'test',
  'max_vus',
  'requests',
  'req_per_s',
  'failed_pct',
  'checks_pass_pct',
  'p95_ms',
  'p99_ms',
  'thresholds_ok',
];

function metricValue(data, name, key) {
  const m = data.metrics && data.metrics[name];
  return m && m.values ? m.values[key] : undefined;
}

function thresholdsOk(data) {
  let sawThreshold = false;
  for (const m of Object.values(data.metrics || {})) {
    if (m.thresholds) {
      sawThreshold = true;
      for (const result of Object.values(m.thresholds)) {
        if (!result.ok) return false;
      }
    }
  }
  return sawThreshold ? true : 'n/a';
}

function toRow(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const base = path.basename(filePath, '.json');
  const [timestampRaw, ...rest] = base.split('__');

  const failedRate = metricValue(data, 'http_req_failed', 'rate');
  const checksRate = metricValue(data, 'checks', 'rate');

  return columns
    .map((col) => {
      switch (col) {
        case 'timestamp':
          return timestampRaw;
        case 'test':
          return rest.join('__') || 'unknown';
        case 'max_vus':
          return metricValue(data, 'vus_max', 'value') ?? '';
        case 'requests':
          return metricValue(data, 'http_reqs', 'count') ?? '';
        case 'req_per_s':
          return metricValue(data, 'http_reqs', 'rate')?.toFixed(2) ?? '';
        case 'failed_pct':
          return failedRate !== undefined ? (failedRate * 100).toFixed(2) : '';
        case 'checks_pass_pct':
          return checksRate !== undefined ? (checksRate * 100).toFixed(2) : '';
        case 'p95_ms':
          return metricValue(data, 'http_req_duration', 'p(95)')?.toFixed(2) ?? '';
        case 'p99_ms':
          return metricValue(data, 'http_req_duration', 'p(99)')?.toFixed(2) ?? '';
        case 'thresholds_ok':
          return thresholdsOk(data);
        default:
          return '';
      }
    })
    .join(',');
}

const files = fs
  .readdirSync(resultsDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => path.join(resultsDir, f));

const rows = [columns.join(','), ...files.map(toRow)];
fs.writeFileSync(csvPath, rows.join('\n') + '\n');

console.log(`Wrote ${files.length} run(s) to ${csvPath}`);
