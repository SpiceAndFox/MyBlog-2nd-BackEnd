function labelKey(labels = {}) {
  return Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${String(value)}`).join(",");
}

function createMemoryMetrics() {
  const counters = new Map();
  const observations = new Map();
  function key(name, labels) { return `${name}{${labelKey(labels)}}`; }
  function increment(name, labels = {}, value = 1) {
    const metricKey = key(name, labels);
    counters.set(metricKey, (counters.get(metricKey) ?? 0) + value);
  }
  function observe(name, labels = {}, value) {
    if (!Number.isFinite(value)) return;
    const metricKey = key(name, labels);
    const current = observations.get(metricKey) ?? { count: 0, sum: 0, min: value, max: value };
    current.count += 1;
    current.sum += value;
    current.min = Math.min(current.min, value);
    current.max = Math.max(current.max, value);
    observations.set(metricKey, current);
  }
  function snapshot() {
    return {
      counters: Object.fromEntries(counters),
      observations: Object.fromEntries([...observations].map(([metricKey, value]) => [metricKey, { ...value, average: value.count ? value.sum / value.count : 0 }])),
    };
  }
  return Object.freeze({ increment, observe, snapshot });
}

module.exports = { createMemoryMetrics };
