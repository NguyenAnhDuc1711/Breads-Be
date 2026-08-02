// Shared k6 handleSummary() formatter: writes a timestamped JSON + text
// report per run into RESULTS_DIR (default "./results", relative to CWD).

function fmtMs(v) {
  return v === undefined || v === null ? 'n/a' : `${v.toFixed(2)}ms`;
}

// k6 auto-splits every http_* metric by tag value into keys like
// "http_reqs{vu_level:150}". Pulls those apart into a per-level table so
// throughput/error-rate can be read off per concurrency tier instead of as
// one number pooled across the whole run.
function buildLevelBreakdown(metrics) {
  const levels = new Map();
  const pattern = /^(\w+)\{vu_level:([^}]+)\}$/;

  for (const [key, m] of Object.entries(metrics)) {
    const match = key.match(pattern);
    if (!match) continue;
    const [, base, level] = match;
    if (!levels.has(level)) levels.set(level, {});
    levels.get(level)[base] = m;
  }

  const sortedLevels = [...levels.keys()]
    .filter((level) => (levels.get(level).http_reqs?.values?.count || 0) > 0)
    .sort((a, b) => Number(a) - Number(b));

  if (sortedLevels.length === 0) return '';

  const rows = sortedLevels.map((level) => {
    const m = levels.get(level);
    const reqs = m.http_reqs && m.http_reqs.values;
    const failed = m.http_req_failed && m.http_req_failed.values;
    const dur = m.http_req_duration && m.http_req_duration.values;
    const failedSamples = failed ? (failed.passes || 0) + (failed.fails || 0) : 0;

    return [
      level.padEnd(7),
      String(reqs ? reqs.count : 'n/a').padEnd(10),
      (reqs && reqs.rate ? reqs.rate.toFixed(2) : 'n/a').padEnd(9),
      (failedSamples > 0 ? (failed.rate * 100).toFixed(2) + '%' : 'n/a').padEnd(10),
      fmtMs(dur && dur.avg).padEnd(12),
      fmtMs(dur && dur['p(95)']),
    ].join('');
  });

  return [
    'By concurrency level (vu_level):',
    '  level  requests  req/s    failed%   avg          p95',
    ...rows.map((r) => `  ${r}`),
    '',
  ].join('\n');
}

function formatText(data, testName, timestamp) {
  const metrics = data.metrics || {};
  const reqs = metrics.http_reqs;
  const dur = metrics.http_req_duration;
  const failed = metrics.http_req_failed;
  const vus = metrics.vus_max;
  const iterations = metrics.iterations;
  const checks = metrics.checks;

  const durValues = (dur && dur.values) || {};
  const failedSamples = failed && failed.values
    ? (failed.values.passes || 0) + (failed.values.fails || 0)
    : 0;
  const failRate = failedSamples > 0
    ? (failed.values.rate * 100).toFixed(2)
    : 'n/a';
  const checkRate = checks && checks.values && checks.values.rate !== undefined
    ? (checks.values.rate * 100).toFixed(2)
    : 'n/a';

  const thresholdLines = [];
  for (const [name, m] of Object.entries(metrics)) {
    if (m.thresholds) {
      for (const [expr, result] of Object.entries(m.thresholds)) {
        thresholdLines.push(`  ${result.ok ? 'PASS' : 'FAIL'}  ${name} ${expr}`);
      }
    }
  }

  const durationMs = data.state && data.state.testRunDurationMs;

  return [
    `Test:        ${testName}`,
    `Timestamp:   ${timestamp}`,
    `Duration:    ${durationMs ? (durationMs / 1000).toFixed(1) + 's' : 'n/a'}`,
    `Max VUs:     ${vus && vus.values ? vus.values.value : 'n/a'}`,
    `Requests:    ${reqs && reqs.values ? reqs.values.count : 'n/a'} (${reqs && reqs.values && reqs.values.rate ? reqs.values.rate.toFixed(2) : 'n/a'} req/s)`,
    `Iterations:  ${iterations && iterations.values ? iterations.values.count : 'n/a'}`,
    `Failed reqs: ${failRate}%`,
    `Checks pass: ${checkRate}%`,
    '',
    'Latency (http_req_duration):',
    `  avg: ${fmtMs(durValues.avg)}  min: ${fmtMs(durValues.min)}  med: ${fmtMs(durValues.med)}`,
    `  p90: ${fmtMs(durValues['p(90)'])}  p95: ${fmtMs(durValues['p(95)'])}  p99: ${fmtMs(durValues['p(99)'])}  max: ${fmtMs(durValues.max)}`,
    '',
    'Thresholds:',
    thresholdLines.length ? thresholdLines.join('\n') : '  (none)',
    '',
    buildLevelBreakdown(metrics),
  ].join('\n');
}

// open() only works during k6's init phase, so the Docker-mount ("/test")
// detection must happen here at module load time (init context), not
// inside buildSummaryFiles() (called during the end-of-test summary phase,
// where open() would throw). This makes saving work regardless of the
// container's WORKDIR, without requiring `docker run -w /test`.
let defaultResultsDir = './results';
try {
  open('/test/lib/handle-summary.js', 'r');
  defaultResultsDir = '/test/results';
} catch (e) {
  // Not running with the /test Docker mount convention; keep the
  // CWD-relative default (e.g. local `k6 run` from the repo root).
}

// Returns the file map for k6's handleSummary(data). Import and call from
// each k6 script's own `export function handleSummary(data)`.
export function buildSummaryFiles(data, testName) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsDir = (__ENV.RESULTS_DIR || defaultResultsDir).replace(/\/$/, '');
  const baseName = `${timestamp}__${testName}`;
  const text = formatText(data, testName, timestamp);

  return {
    stdout: text,
    [`${resultsDir}/${baseName}.json`]: JSON.stringify(data, null, 2),
    [`${resultsDir}/${baseName}.txt`]: text,
  };
}
