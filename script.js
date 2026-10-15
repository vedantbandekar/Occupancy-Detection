/*
 * SmartRoom dashboard data layer.
 * Keep hardware-specific endpoint and JSON field mapping here so firmware changes
 * do not require rewriting the presentation layer.
 */

const CONFIG = Object.freeze({
  // Start in an unmistakably labelled preview. Set to "live" when an ESP32 endpoint exists.
  MODE: "demo", // "demo" | "live"

  // Provisional endpoint. If the page is served by the ESP32, a relative path can work.
  // Otherwise replace it with the actual device URL, for example http://<esp32-address>/api/status.
  API_ENDPOINT: "/api/status",

  // Polling, timeout and freshness limits can be tuned to the firmware's reporting rate.
  POLL_INTERVAL_MS: 2500,
  REQUEST_TIMEOUT_MS: 5000,
  MAX_DATA_AGE_MS: 15000,

  // Set true ONLY after confirming that environment.aqi_level (or app_aqi_level)
  // is already an application-mapped level from 1–5, not the ENS160 native output.
  AQI_LEVEL_MAPPING_CONFIRMED: false,

  // Application-defined presentation bands. These are UI hints, not manufacturer
  // thresholds or medical/safety guidance. Update them for the room and document changes.
  INTERPRETATION_BANDS: Object.freeze({
    temperatureC: Object.freeze({ min: 18, max: 28 }),
    humidityPercent: Object.freeze({ min: 30, max: 65 }),
    illuminanceLux: Object.freeze({ dimBelow: 50, moderateBelow: 250, wellLitBelow: 700 })
  })
});

const APP_MODE = CONFIG.MODE === "live" ? "live" : "demo";
const AIR_QUALITY_LABELS = Object.freeze({
  1: "Excellent",
  2: "Good",
  3: "Moderate",
  4: "Poor",
  5: "Very poor"
});

const SENSOR_DEFINITIONS = Object.freeze([
  { key: "ld2412", name: "LD2412", purpose: "Human presence", statusId: "sensorStatusLd2412", lastId: "sensorLastLd2412" },
  { key: "aht21", name: "AHT21", purpose: "Temperature & humidity", statusId: "sensorStatusAht21", lastId: "sensorLastAht21" },
  { key: "ens160", name: "ENS160", purpose: "Air quality, TVOC & eCO₂", statusId: "sensorStatusEns160", lastId: "sensorLastEns160" },
  { key: "opt3004", name: "OPT3004", purpose: "Ambient light", statusId: "sensorStatusOpt3004", lastId: "sensorLastOpt3004" }
]);

const state = {
  mode: APP_MODE,
  currentRecord: null,
  requestInFlight: false,
  lastSuccessfulResponseAt: null,
  lastError: null,
  pollTimer: null,
  manualRefreshAt: null
};

const $ = (id) => document.getElementById(id);

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function setBadge(id, text, kind) {
  const node = $(id);
  if (!node) return;
  node.className = `status-badge ${kind}`;
  const label = node.querySelector("span:last-child");
  if (label) label.textContent = text;
}

function setStateTag(node, label, stateClass) {
  if (!node) return;
  node.className = `metric-state ${stateClass}`;
  node.textContent = label;
}

function formatNumber(value, maximumFractionDigits = 1, minimumFractionDigits = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits,
    minimumFractionDigits,
    useGrouping: true
  }).format(value);
}

function parseDate(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  // A device clock far ahead of the browser clock should not make stale data appear fresh.
  if (parsed.getTime() > Date.now() + 60_000) return null;
  return parsed;
}

function formatClock(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit"
  }).format(date);
}

function relativeTime(date, now = Date.now()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "Not available";
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function readFiniteNumber(value, options = {}) {
  // Accept JSON numbers and numeric strings, but never coerce null, booleans or empty strings to 0.
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (options.min !== undefined && parsed < options.min) return null;
  if (options.max !== undefined && parsed > options.max) return null;
  if (options.integer && !Number.isInteger(parsed)) return null;
  return parsed;
}

function readOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mapSensorStatus(entry) {
  // Firmware can report a boolean, { available: boolean }, or { status: "online" }.
  if (typeof entry === "boolean") return { status: entry ? "online" : "offline", lastSeen: null };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    if (typeof entry === "string") {
      const word = entry.trim().toLowerCase();
      if (["online", "connected", "ready", "ok"].includes(word)) return { status: "online", lastSeen: null };
      if (["offline", "disconnected", "error", "unavailable"].includes(word)) return { status: "offline", lastSeen: null };
    }
    return { status: "unknown", lastSeen: null };
  }

  if (typeof entry.available === "boolean") {
    return { status: entry.available ? "online" : "offline", lastSeen: parseDate(entry.last_reading_timestamp ?? entry.last_seen) };
  }
  if (typeof entry.connected === "boolean") {
    return { status: entry.connected ? "online" : "offline", lastSeen: parseDate(entry.last_reading_timestamp ?? entry.last_seen) };
  }
  const word = readOptionalString(entry.status ?? entry.state)?.toLowerCase();
  if (["online", "connected", "ready", "ok"].includes(word)) return { status: "online", lastSeen: parseDate(entry.last_reading_timestamp ?? entry.last_seen) };
  if (["offline", "disconnected", "error", "unavailable"].includes(word)) return { status: "offline", lastSeen: parseDate(entry.last_reading_timestamp ?? entry.last_seen) };
  return { status: "unknown", lastSeen: parseDate(entry.last_reading_timestamp ?? entry.last_seen) };
}

function findSensorEntry(sensorMap, canonicalKey) {
  if (!sensorMap || typeof sensorMap !== "object" || Array.isArray(sensorMap)) return undefined;
  const aliases = {
    ld2412: ["ld2412", "presence", "presence_sensor"],
    aht21: ["aht21", "temperature_humidity", "climate"],
    ens160: ["ens160", "air_quality"],
    opt3004: ["opt3004", "ambient_light", "light"]
  }[canonicalKey] || [canonicalKey];
  const normalizedEntries = Object.entries(sensorMap).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ""), value]);
  const normalizedAliases = aliases.map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const match = normalizedEntries.find(([key]) => normalizedAliases.includes(key));
  return match ? match[1] : undefined;
}

/**
 * Firmware adapter: this is the one place to map the real ESP32 JSON field names,
 * value units, sensor health shape, device metadata and timestamp into the UI model.
 * The current mapping follows the provisional contract in README.md.
 */
function normalizeSensorData(rawData) {
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
    throw new Error("The endpoint response must be a JSON object.");
  }

  const knownSections = ["occupancy", "environment", "light", "system", "sensors", "sensor_status", "sensorStatus"];
  const hasKnownSection = knownSections.some((key) => Object.prototype.hasOwnProperty.call(rawData, key))
    || Object.prototype.hasOwnProperty.call(rawData, "device_id")
    || Object.prototype.hasOwnProperty.call(rawData, "timestamp");
  if (!hasKnownSection) {
    throw new Error("The JSON shape was not recognized. Update normalizeSensorData() to match the firmware contract.");
  }

  const occupancyRaw = rawData.occupancy && typeof rawData.occupancy === "object" ? rawData.occupancy : {};
  const environmentRaw = rawData.environment && typeof rawData.environment === "object" ? rawData.environment : {};
  const lightRaw = rawData.light && typeof rawData.light === "object" ? rawData.light : {};
  const systemRaw = rawData.system && typeof rawData.system === "object" ? rawData.system : {};

  // Units are expected to be °C, %, lux, ppb and ppm. Convert here if firmware differs.
  const temperatureC = readFiniteNumber(environmentRaw.temperature_c);
  const humidityPercent = readFiniteNumber(environmentRaw.humidity_percent, { min: 0, max: 100 });
  const tvocPpb = readFiniteNumber(environmentRaw.tvoc_ppb, { min: 0 });
  const eco2Ppm = readFiniteNumber(environmentRaw.eco2_ppm, { min: 0 });
  const illuminanceLux = readFiniteNumber(lightRaw.illuminance_lux, { min: 0 });

  // A native ENS160 AQI output is not automatically treated as the application's 1–5 scale.
  const nativeAqiValue = environmentRaw.aqi_output ?? environmentRaw.aqi ?? environmentRaw.aqi_level;
  const aqiOutput = readFiniteNumber(nativeAqiValue, { min: 0 });
  const appLevelCandidate = environmentRaw.app_aqi_level ?? environmentRaw.aqi_level;
  const appAqiLevel = CONFIG.AQI_LEVEL_MAPPING_CONFIRMED
    ? readFiniteNumber(appLevelCandidate, { min: 1, max: 5, integer: true })
    : null;

  const occupied = typeof occupancyRaw.occupied === "boolean" ? occupancyRaw.occupied : null;
  const occupancyAvailable = occupancyRaw.available === false ? false : occupied !== null;
  const sensorsRaw = rawData.sensors ?? rawData.sensor_status ?? rawData.sensorStatus ?? {};
  const sensorHealth = {};
  for (const definition of SENSOR_DEFINITIONS) {
    sensorHealth[definition.key] = mapSensorStatus(findSensorEntry(sensorsRaw, definition.key));
  }

  const measurementTimestamp = parseDate(rawData.timestamp ?? rawData.measured_at ?? rawData.sampled_at);
  const measurementPresent = occupied !== null && occupancyRaw.available !== false
    || temperatureC !== null
    || humidityPercent !== null
    || aqiOutput !== null
    || appAqiLevel !== null
    || tvocPpb !== null
    || eco2Ppm !== null
    || illuminanceLux !== null;

  return {
    source: "live",
    deviceId: readOptionalString(rawData.device_id ?? systemRaw.device_id),
    firmwareVersion: readOptionalString(systemRaw.firmware_version ?? rawData.firmware_version),
    measurementAt: measurementTimestamp,
    receivedAt: Date.now(),
    occupancy: { occupied, available: occupancyAvailable },
    environment: { temperatureC, humidityPercent, aqiOutput, appAqiLevel, tvocPpb, eco2Ppm },
    illuminanceLux,
    system: {
      connected: typeof systemRaw.connected === "boolean" ? systemRaw.connected : null,
      wifiConnected: typeof systemRaw.wifi_connected === "boolean" ? systemRaw.wifi_connected : null
    },
    sensorHealth,
    hasMeasurement: Boolean(measurementPresent)
  };
}

function makeDemoData() {
  // Demonstration values are static examples only and are never used in live mode.
  return {
    source: "demo",
    deviceId: null,
    firmwareVersion: null,
    measurementAt: null,
    receivedAt: null,
    occupancy: { occupied: true, available: true },
    environment: {
      temperatureC: 27.4,
      humidityPercent: 61.2,
      aqiOutput: null,
      appAqiLevel: 2,
      tvocPpb: 143,
      eco2Ppm: 650
    },
    illuminanceLux: 284,
    system: { connected: null, wifiConnected: null },
    sensorHealth: {
      ld2412: { status: "demo", lastSeen: null },
      aht21: { status: "demo", lastSeen: null },
      ens160: { status: "demo", lastSeen: null },
      opt3004: { status: "demo", lastSeen: null }
    },
    hasMeasurement: true
  };
}

function effectiveRecordTime(record) {
  if (!record) return null;
  return record.measurementAt || record.receivedAt || null;
}

function recordAgeMs(record, now = Date.now()) {
  const date = effectiveRecordTime(record);
  if (!(date instanceof Date)) return null;
  return Math.max(0, now - date.getTime());
}

function isRecordStale(record = state.currentRecord, now = Date.now()) {
  if (state.mode !== "live" || !record || !record.hasMeasurement) return false;
  const age = recordAgeMs(record, now);
  return age !== null && age > CONFIG.MAX_DATA_AGE_MS;
}

function currentStreamState(now = Date.now()) {
  if (state.mode === "demo") return "demo";
  if (!state.currentRecord) return state.lastError ? "error" : (state.requestInFlight ? "waiting" : "waiting");
  if (isRecordStale(state.currentRecord, now)) return "stale";
  if (state.lastError) return "error";
  if (!state.currentRecord.hasMeasurement) return "no-readings";
  return "receiving";
}

function renderMode() {
  const demo = state.mode === "demo";
  const demoNotice = $("demoNotice");
  if (demoNotice) demoNotice.hidden = !demo;
  setText("sidebarMode", demo ? "Demo preview" : "Live hardware mode");
  const dot = $("sidebarModeDot");
  if (dot) {
    dot.className = "sidebar-mode-dot";
    if (!demo) dot.classList.add("is-live");
  }
  setBadge("modeBadge", demo ? "DEMO DATA" : "LIVE MODE", demo ? "badge-demo" : "badge-muted");
}

function renderTopbar(now = Date.now()) {
  const record = state.currentRecord;
  const stale = isRecordStale(record, now);
  const streamState = currentStreamState(now);

  if (state.mode === "demo") {
    setBadge("controllerBadge", "ESP32 · NOT TESTED", "badge-muted");
    setBadge("streamBadge", "STREAM · SAMPLE", "badge-demo");
    setText("lastUpdated", "Demo dataset");
    setText("timestampHint", "Sample values · not measured");
    setText("headingFeedText", "Preview data");
  } else {
    const reportedConnected = record?.system?.connected;
    if (reportedConnected === true && !stale && !state.lastError) {
      setBadge("controllerBadge", "ESP32 · CONNECTED", "badge-success");
    } else if (reportedConnected === false && !stale && !state.lastError) {
      setBadge("controllerBadge", "ESP32 · OFFLINE", "badge-danger");
    } else if (reportedConnected !== null && reportedConnected !== undefined) {
      setBadge("controllerBadge", "ESP32 · LAST KNOWN", "badge-warning");
    } else {
      setBadge("controllerBadge", "ESP32 · UNKNOWN", "badge-muted");
    }

    if (streamState === "receiving") setBadge("streamBadge", "STREAM · RECEIVING", "badge-success");
    else if (streamState === "stale") setBadge("streamBadge", "STREAM · STALE", "badge-warning");
    else if (streamState === "error") setBadge("streamBadge", "STREAM · REQUEST ERROR", "badge-danger");
    else if (streamState === "no-readings") setBadge("streamBadge", "STREAM · NO READINGS", "badge-warning");
    else setBadge("streamBadge", "STREAM · WAITING", "badge-muted");

    const effectiveTime = effectiveRecordTime(record);
    setText("lastUpdated", effectiveTime ? relativeTime(effectiveTime, now) : "Waiting for data");
    if (record?.measurementAt && record.hasMeasurement) {
      setText("timestampHint", `Sensor timestamp · ${formatClock(record.measurementAt)}`);
    } else if (record?.receivedAt) {
      setText("timestampHint", `Browser receipt time · ${formatClock(record.receivedAt)}`);
    } else {
      setText("timestampHint", "No successful response yet");
    }
    setText("headingFeedText", streamState === "receiving" ? "Receiving sensor data" : streamState === "stale" ? "Latest reading is stale" : streamState === "error" ? "Connection error" : streamState === "no-readings" ? "No sensor readings" : "Waiting for ESP32 data");
  }

  const headingDot = document.querySelector(".heading-live .live-dot");
  if (headingDot) {
    headingDot.className = "live-dot";
    const dotState = state.mode === "demo"
      ? "is-demo"
      : streamState === "receiving"
        ? "is-live"
        : (streamState === "stale" || streamState === "error")
          ? "is-stale"
          : "";
    if (dotState) headingDot.classList.add(dotState);
  }
}

function renderNotice(now = Date.now()) {
  const node = $("connectionNotice");
  if (!node) return;
  if (state.mode === "demo") {
    node.hidden = true;
    return;
  }

  const streamState = currentStreamState(now);
  node.hidden = false;
  node.classList.remove("is-error");
  if (state.lastError) {
    node.classList.add("is-error");
    setText("connectionNoticeTitle", "Unable to get a fresh response from the configured endpoint");
    const detail = state.lastSuccessfulResponseAt
      ? `Last successful response ${relativeTime(state.lastSuccessfulResponseAt, now)}. Check the ESP32 address, Wi-Fi network, and browser CORS configuration.`
      : "No valid response has been received yet. Check the endpoint address, local network, and browser CORS configuration.";
    setText("connectionNoticeText", `${state.lastError} ${detail}`);
  } else if (streamState === "stale") {
    setText("connectionNoticeTitle", "Latest sensor reading is stale");
    setText("connectionNoticeText", `The last valid measurement is ${relativeTime(effectiveRecordTime(state.currentRecord), now)} old. Values remain marked as last known; waiting for a fresh timestamp.`);
  } else if (!state.currentRecord) {
    setText("connectionNoticeTitle", state.requestInFlight ? "Connecting to the configured ESP32 endpoint…" : "Waiting for the first sensor response");
    setText("connectionNoticeText", "No sensor readings are shown until a valid JSON response is received.");
  } else if (!state.currentRecord.hasMeasurement) {
    setText("connectionNoticeTitle", "Gateway responded, but no valid sensor readings were included");
    setText("connectionNoticeText", "Check that the response contains at least one supported, finite sensor value or an occupancy state.");
  } else {
    node.hidden = true;
  }
}

function statusForInterpretation(value, bands, lowLabel, inLabel, highLabel) {
  if (value === null) return { label: "NO DATA", description: "No valid sensor reading received.", className: "state-neutral" };
  if (value < bands.min) return { label: lowLabel.toUpperCase(), description: `Below the configured display band (${bands.min}–${bands.max}).`, className: "state-caution" };
  if (value > bands.max) return { label: highLabel.toUpperCase(), description: `Above the configured display band (${bands.min}–${bands.max}).`, className: "state-caution" };
  return { label: inLabel.toUpperCase(), description: `Within the configured display band (${bands.min}–${bands.max}).`, className: "state-positive" };
}

function lightInterpretation(value) {
  if (value === null) return { label: "NO DATA", description: "No valid OPT3004 reading received.", className: "state-neutral" };
  const bands = CONFIG.INTERPRETATION_BANDS.illuminanceLux;
  if (value < bands.dimBelow) return { label: "DIM", description: `Dim by the configured display bands (under ${bands.dimBelow} lux).`, className: "state-info" };
  if (value < bands.moderateBelow) return { label: "MODERATE", description: `Moderate by the configured display bands (${bands.dimBelow}–${bands.moderateBelow} lux).`, className: "state-info" };
  if (value < bands.wellLitBelow) return { label: "WELL LIT", description: `Well lit by the configured display bands (${bands.moderateBelow}–${bands.wellLitBelow} lux).`, className: "state-positive" };
  return { label: "BRIGHT", description: `Bright by the configured display bands (${bands.wellLitBelow} lux or more).`, className: "state-caution" };
}

function setMetricReading(config) {
  const valueNode = $(config.valueId);
  const unitNode = $(config.unitId);
  const descriptionNode = $(config.descriptionId);
  const stateNode = $(config.stateId);
  const cardNode = $(config.cardId);
  const available = typeof config.value === "number" && Number.isFinite(config.value);
  const stale = available && state.mode === "live" && isRecordStale();

  if (valueNode) valueNode.textContent = available ? config.formattedValue : "—";
  if (unitNode) unitNode.hidden = !available;
  if (descriptionNode) descriptionNode.textContent = !available
    ? config.missingDescription
    : stale ? `Last valid reading · ${config.description}` : config.description;
  if (stateNode) {
    if (!available) setStateTag(stateNode, "NO DATA", "state-neutral");
    else if (stale) setStateTag(stateNode, "STALE", "state-caution");
    else setStateTag(stateNode, config.stateLabel, config.stateClass);
  }
  if (cardNode) cardNode.classList.toggle("is-stale", Boolean(stale));
}

function renderAirQuality(record) {
  const environment = record?.environment;
  const level = environment?.appAqiLevel ?? null;
  const output = environment?.aqiOutput ?? null;
  const valueNode = $("airQualityValue");
  const descriptionNode = $("airQualityDescription");
  const levelNode = $("airQualityLevel");
  const scale = $("airQualityScale");
  const stateNode = $("airQualityState");
  const card = $("airQualityCard");
  const stale = state.mode === "live" && Boolean(record?.hasMeasurement) && isRecordStale(record);

  if (level !== null && AIR_QUALITY_LABELS[level]) {
    valueNode.textContent = AIR_QUALITY_LABELS[level].toUpperCase();
    descriptionNode.textContent = state.mode === "demo"
      ? "Demo application scale · mapping must be validated against the sensor output."
      : "Application-defined category · level mapping enabled in configuration.";
    levelNode.textContent = `LEVEL ${level} / 5`;
    scale.dataset.level = String(level);
    scale.setAttribute("aria-label", `Application-defined air quality level ${level} of 5: ${AIR_QUALITY_LABELS[level]}`);
    setStateTag(stateNode, stale ? "STALE" : "APP LEVEL", stale ? "state-caution" : "state-info");
  } else if (output !== null) {
    valueNode.textContent = `AQI ${formatNumber(output, 1)}`;
    descriptionNode.textContent = stale
      ? "Last valid output · application category mapping is pending."
      : "AQI output received · application category mapping is pending.";
    levelNode.textContent = "LEVEL — / 5";
    scale.removeAttribute("data-level");
    scale.setAttribute("aria-label", "Native or unmapped AQI output shown; application five-level scale is pending");
    setStateTag(stateNode, stale ? "STALE" : "RAW OUTPUT", stale ? "state-caution" : "state-info");
  } else {
    valueNode.textContent = "—";
    descriptionNode.textContent = "No valid AQI output or configured application level received.";
    levelNode.textContent = "LEVEL — / 5";
    scale.removeAttribute("data-level");
    scale.setAttribute("aria-label", "Application-defined air quality level not available");
    setStateTag(stateNode, "NO DATA", "state-neutral");
  }
  if (card) card.classList.toggle("is-stale", stale);
}

function renderMetrics() {
  const record = state.currentRecord;
  const environment = record?.environment || {};
  const temperatureBands = CONFIG.INTERPRETATION_BANDS.temperatureC;
  const humidityBands = CONFIG.INTERPRETATION_BANDS.humidityPercent;

  setText("temperatureRange", `Band ${temperatureBands.min}–${temperatureBands.max} °C`);
  setText("humidityRange", `Band ${humidityBands.min}–${humidityBands.max}%`);

  const temperatureInfo = statusForInterpretation(environment.temperatureC ?? null, temperatureBands, "Cool", "Within band", "Warm");
  setMetricReading({
    cardId: "temperatureCard", valueId: "temperatureValue", unitId: "temperatureUnit", descriptionId: "temperatureDescription", stateId: "temperatureState",
    value: environment.temperatureC ?? null,
    formattedValue: formatNumber(environment.temperatureC, 1, 1),
    stateLabel: temperatureInfo.label, stateClass: temperatureInfo.className, description: temperatureInfo.description,
    missingDescription: "Waiting for a valid AHT21 temperature reading."
  });

  const humidityInfo = statusForInterpretation(environment.humidityPercent ?? null, humidityBands, "Dry", "Within band", "Humid");
  setMetricReading({
    cardId: "humidityCard", valueId: "humidityValue", unitId: "humidityUnit", descriptionId: "humidityDescription", stateId: "humidityState",
    value: environment.humidityPercent ?? null,
    formattedValue: formatNumber(environment.humidityPercent, 1, 1),
    stateLabel: humidityInfo.label, stateClass: humidityInfo.className, description: humidityInfo.description,
    missingDescription: "Waiting for a valid AHT21 humidity reading."
  });

  renderAirQuality(record);

  const lightInfo = lightInterpretation(record?.illuminanceLux ?? null);
  setMetricReading({
    cardId: "lightCard", valueId: "lightValue", unitId: "lightUnit", descriptionId: "lightDescription", stateId: "lightState",
    value: record?.illuminanceLux ?? null,
    formattedValue: formatNumber(record?.illuminanceLux, 1, 0),
    stateLabel: lightInfo.label, stateClass: lightInfo.className, description: lightInfo.description,
    missingDescription: "Waiting for a valid OPT3004 illuminance reading."
  });

  const tvoc = environment.tvocPpb ?? null;
  setMetricReading({
    cardId: "tvocCard", valueId: "tvocValue", unitId: "tvocUnit", descriptionId: "tvocDescription", stateId: "tvocState",
    value: tvoc,
    formattedValue: formatNumber(tvoc, 1, 0),
    stateLabel: "RAW READING", stateClass: "state-info",
    description: "TVOC indicator · not gas-specific or a safety alarm.",
    missingDescription: "Waiting for a valid ENS160 TVOC reading."
  });

  const eco2 = environment.eco2Ppm ?? null;
  setMetricReading({
    cardId: "eco2Card", valueId: "eco2Value", unitId: "eco2Unit", descriptionId: "eco2Description", stateId: "eco2State",
    value: eco2,
    formattedValue: formatNumber(eco2, 1, 0),
    stateLabel: "ESTIMATE", stateClass: "state-info",
    description: "ENS160 eCO₂ estimate · not a direct CO₂ measurement.",
    missingDescription: "Waiting for a valid ENS160 eCO₂ estimate."
  });

  const streamState = currentStreamState();
  const statusNode = $("readingsStatus");
  if (statusNode) {
    statusNode.className = "section-state";
    let label = "Waiting for data";
    if (state.mode === "demo") { label = "Demo sample values"; statusNode.classList.add("is-demo"); }
    else if (streamState === "receiving") { label = "Live · receiving"; statusNode.classList.add("is-live"); }
    else if (streamState === "stale") { label = "Last reading · stale"; statusNode.classList.add("is-stale"); }
    else if (streamState === "error") { label = "Request error"; statusNode.classList.add("is-error"); }
    else if (streamState === "no-readings") { label = "No valid sensor values"; statusNode.classList.add("is-stale"); }
    else if (!state.requestInFlight) label = "Awaiting first reading";
    const labelNode = statusNode.querySelector("span:last-child");
    if (labelNode) labelNode.textContent = label;
  }
}

function renderOccupancy(now = Date.now()) {
  const record = state.currentRecord;
  const occupancy = record?.occupancy;
  const value = occupancy && occupancy.available ? occupancy.occupied : null;
  const stale = state.mode === "live" && value !== null && isRecordStale(record, now);
  const title = $("occupancyTitle");
  const badge = $("occupancyBadge");
  const description = $("occupancyDescription");
  const availability = $("presenceAvailability");
  const feedTitle = $("presenceFeedTitle");
  const feedText = $("presenceFeedText");
  const freshness = $("occupancyFreshness");
  const iconWrap = $("presenceIconWrap");
  const sensorState = record?.sensorHealth?.ld2412?.status || "unknown";

  if (iconWrap) iconWrap.className = "presence-icon-wrap";
  if (state.mode === "demo") {
    title.textContent = "OCCUPIED";
    badge.className = "state-tag state-stale";
    badge.textContent = "SAMPLE";
    description.textContent = "Sample state: person detected. This is not a live LD2412 reading.";
    availability.textContent = "Demo only · no sensor link";
    feedTitle.textContent = "Sample presence state";
    feedText.textContent = "The example shows an occupied room; no physical sensor has reported this state.";
    freshness.textContent = "Illustrative value · not measured";
    iconWrap.classList.add("is-occupied");
  } else if (value === true) {
    title.textContent = "OCCUPIED";
    badge.className = stale ? "state-tag state-stale" : "state-tag state-occupied";
    badge.textContent = stale ? "STALE DATA" : "PERSON DETECTED";
    description.textContent = stale
      ? "Last valid report indicated presence. Current occupancy is unknown until a fresh update arrives."
      : "Person detected in the room.";
    feedTitle.textContent = stale ? "Last report: presence detected" : "Presence reported";
    feedText.textContent = stale ? "The last state is retained for context and is not presented as current." : "Presence is reported separately from an empty room or a device connection failure.";
    iconWrap.classList.add("is-occupied");
  } else if (value === false) {
    title.textContent = "NOT OCCUPIED";
    badge.className = stale ? "state-tag state-stale" : "state-tag state-unoccupied";
    badge.textContent = stale ? "STALE DATA" : "NO PRESENCE";
    description.textContent = stale
      ? "Last valid report indicated no presence. Current occupancy is unknown until a fresh update arrives."
      : "No presence detected.";
    feedTitle.textContent = stale ? "Last report: no presence" : "No presence reported";
    feedText.textContent = stale ? "This was the last known sensor state; it may no longer represent the room." : "An unoccupied room is a normal status, not a sensor error.";
    iconWrap.classList.add("is-unoccupied");
  } else {
    title.textContent = state.currentRecord ? "PRESENCE UNAVAILABLE" : "WAITING FOR DATA";
    badge.className = "state-tag state-unavailable";
    badge.textContent = state.currentRecord ? "UNAVAILABLE" : "UNKNOWN";
    description.textContent = "Presence data unavailable. A communication failure is not treated as an empty room.";
    feedTitle.textContent = "Presence data unavailable";
    feedText.textContent = "The LD2412 state is missing or explicitly unavailable in the latest response.";
    iconWrap.classList.add("is-unavailable");
  }

  if (state.mode !== "demo") {
    if (sensorState === "online") availability.textContent = "LD2412 health: Online";
    else if (sensorState === "offline") availability.textContent = "LD2412 health: Offline";
    else if (value !== null) availability.textContent = "Reading received · health unknown";
    else availability.textContent = "Sensor availability unknown";
    const recordTime = effectiveRecordTime(record);
    freshness.textContent = stale
      ? `Stale · last report ${relativeTime(recordTime, now)}`
      : recordTime ? `${record.measurementAt ? "Measured" : "Received"} ${relativeTime(recordTime, now)}` : "No measurement received";
  }
}

function sensorStatusPresentation(sensorHealth) {
  if (state.mode === "demo") return { label: "DEMO ONLY", className: "state-demo", note: "Sample values · no sensor link" };
  const status = sensorHealth?.status || "unknown";
  if (status === "online") return { label: "ONLINE", className: "state-online", note: sensorHealth.lastSeen ? `Last report ${relativeTime(sensorHealth.lastSeen)}` : "Firmware reports available" };
  if (status === "offline") return { label: "OFFLINE", className: "state-offline", note: "Firmware reports unavailable" };
  return { label: "UNKNOWN", className: "state-unknown", note: "Health not reported by firmware" };
}

function renderSensors() {
  const record = state.currentRecord;
  let reported = 0;
  for (const definition of SENSOR_DEFINITIONS) {
    const presentation = sensorStatusPresentation(record?.sensorHealth?.[definition.key]);
    const statusNode = $(definition.statusId);
    const lastNode = $(definition.lastId);
    if (statusNode) {
      statusNode.className = `sensor-status ${presentation.className}`;
      statusNode.textContent = presentation.label;
    }
    if (lastNode) lastNode.textContent = presentation.note;
    if (state.mode === "live" && ["online", "offline"].includes(record?.sensorHealth?.[definition.key]?.status)) reported += 1;
  }

  if (state.mode === "demo") setText("sensorSummary", "Sample data only · no hardware status");
  else if (reported === SENSOR_DEFINITIONS.length) setText("sensorSummary", "Health reported for all four sensors");
  else if (reported > 0) setText("sensorSummary", `Health reported for ${reported} of 4 sensors`);
  else setText("sensorSummary", "Independent status not verified");
}

function setDiagnosticValue(id, value, tone = "") {
  const node = $(id);
  if (!node) return;
  node.textContent = value;
  node.className = `diagnostic-value${tone ? ` ${tone}` : ""}`;
}

function renderSystem(now = Date.now()) {
  const record = state.currentRecord;
  const streamState = currentStreamState(now);
  const stale = streamState === "stale";
  const connected = record?.system?.connected;
  const wifiConnected = record?.system?.wifiConnected;
  const heartbeat = $("systemHeartbeat");

  if (state.mode === "demo") {
    setDiagnosticValue("diagController", "Demo only", "is-muted");
    setText("diagControllerNote", "No ESP32 request made");
    setDiagnosticValue("diagWifi", "Not checked", "is-muted");
    setText("diagWifiNote", "No physical Wi-Fi status");
    setDiagnosticValue("diagStream", "Sample data", "is-warning");
    setText("diagStreamNote", "Static preview values");
    setDiagnosticValue("diagDeviceId", "Not available", "is-muted");
    setDiagnosticValue("diagFirmware", "Not available", "is-muted");
    setDiagnosticValue("diagLastReading", "Not measured", "is-muted");
    setText("diagTimestampSource", "Demo values · no timestamp");
    if (heartbeat) {
      heartbeat.className = "heartbeat-state is-demo";
      heartbeat.querySelector("span:last-child").textContent = "Demo data only";
    }
    return;
  }

  if (connected === true) {
    setDiagnosticValue("diagController", stale || state.lastError ? "Last reported connected" : "Connected", stale || state.lastError ? "is-warning" : "is-good");
    setText("diagControllerNote", stale || state.lastError ? "Current connection not confirmed" : "Reported by firmware");
  } else if (connected === false) {
    setDiagnosticValue("diagController", stale || state.lastError ? "Last reported offline" : "Disconnected", stale || state.lastError ? "is-warning" : "is-bad");
    setText("diagControllerNote", "Reported by firmware");
  } else {
    setDiagnosticValue("diagController", "Unknown", "is-muted");
    setText("diagControllerNote", "Not reported by firmware");
  }

  if (wifiConnected === true) {
    setDiagnosticValue("diagWifi", stale ? "Last reported connected" : "Connected", stale ? "is-warning" : "is-good");
    setText("diagWifiNote", stale ? "Current state not confirmed" : "Reported by firmware");
  } else if (wifiConnected === false) {
    setDiagnosticValue("diagWifi", stale ? "Last reported offline" : "Disconnected", stale ? "is-warning" : "is-bad");
    setText("diagWifiNote", "Reported by firmware");
  } else {
    setDiagnosticValue("diagWifi", "Unknown", "is-muted");
    setText("diagWifiNote", "Not reported by firmware");
  }

  const streamLabels = {
    receiving: ["Receiving", "is-good", "HTTP response and readings are current"],
    stale: ["Stale", "is-warning", "Last measurement exceeds freshness limit"],
    error: ["Request error", "is-bad", "Latest endpoint request failed"],
    "no-readings": ["No readings", "is-warning", "Response had no valid sensor values"],
    waiting: ["Waiting", "is-muted", "No valid response yet"],
    demo: ["Sample data", "is-muted", "Static preview values"]
  };
  const [streamLabel, streamTone, streamNote] = streamLabels[streamState] || streamLabels.waiting;
  setDiagnosticValue("diagStream", streamLabel, streamTone);
  setText("diagStreamNote", streamNote);
  setDiagnosticValue("diagDeviceId", record?.deviceId || "Not available", record?.deviceId ? "" : "is-muted");
  setDiagnosticValue("diagFirmware", record?.firmwareVersion || "Not available", record?.firmwareVersion ? "" : "is-muted");

  const time = effectiveRecordTime(record);
  if (record?.hasMeasurement && time) {
    setDiagnosticValue("diagLastReading", relativeTime(time, now), stale ? "is-warning" : "");
    setText("diagTimestampSource", record.measurementAt ? `Measured · ${formatClock(record.measurementAt)}` : `Received · ${formatClock(record.receivedAt)}`);
  } else if (record) {
    setDiagnosticValue("diagLastReading", "No sensor values", "is-muted");
    setText("diagTimestampSource", record.measurementAt ? `Response time · ${formatClock(record.measurementAt)}` : "No measurement timestamp");
  } else {
    setDiagnosticValue("diagLastReading", "Not received", "is-muted");
    setText("diagTimestampSource", "Measurement time unavailable");
  }

  if (heartbeat) {
    heartbeat.className = "heartbeat-state";
    let heartbeatText = "Awaiting data";
    if (streamState === "receiving") { heartbeat.classList.add("is-good"); heartbeatText = "Response received"; }
    else if (streamState === "stale" || streamState === "no-readings") { heartbeat.classList.add("is-warning"); heartbeatText = streamState === "stale" ? "Data is stale" : "No sensor readings"; }
    else if (streamState === "error") { heartbeat.classList.add("is-error"); heartbeatText = "Request failed"; }
    const textNode = heartbeat.querySelector("span:last-child");
    if (textNode) textNode.textContent = heartbeatText;
  }
}

function renderAll(now = Date.now()) {
  renderMode();
  renderTopbar(now);
  renderNotice(now);
  renderOccupancy(now);
  renderMetrics();
  renderSensors();
  renderSystem(now);
}

function scheduleNextPoll() {
  if (state.mode !== "live") return;
  window.clearTimeout(state.pollTimer);
  state.pollTimer = window.setTimeout(() => fetchSensorData(), CONFIG.POLL_INTERVAL_MS);
}

/**
 * Fetches, parses and normalizes one live ESP32 response.
 * A single in-flight guard plus completion-based scheduling prevents overlapping polls.
 */
async function fetchSensorData(options = {}) {
  if (state.mode === "demo") {
    state.manualRefreshAt = Date.now();
    renderAll();
    return;
  }
  if (state.requestInFlight) return;

  state.requestInFlight = true;
  const refreshButton = $("refreshButton");
  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.classList.add("is-loading");
    refreshButton.setAttribute("aria-busy", "true");
  }
  renderAll();

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
  try {
    // Browser/network/CORS errors are caught below and shown without substituting demo values.
    const response = await fetch(CONFIG.API_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      mode: "cors",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || "request failed"}.`);

    // JSON parsing and hardware field mapping are deliberately separate from rendering.
    const rawData = await response.json();
    const normalized = normalizeSensorData(rawData);
    normalized.receivedAt = new Date();
    state.currentRecord = normalized;
    state.lastSuccessfulResponseAt = normalized.receivedAt;
    state.lastError = null;
  } catch (error) {
    if (error?.name === "AbortError") {
      state.lastError = `Request timed out after ${CONFIG.REQUEST_TIMEOUT_MS / 1000} seconds.`;
    } else if (error instanceof TypeError) {
      state.lastError = "Network or CORS error. The browser could not read the ESP32 response.";
    } else {
      state.lastError = error?.message || "Unexpected request error.";
    }
    // Keep any previous live response for context; rendering marks it stale when its age exceeds the limit.
  } finally {
    window.clearTimeout(timeoutId);
    state.requestInFlight = false;
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.classList.remove("is-loading");
      refreshButton.removeAttribute("aria-busy");
    }
    renderAll();
    scheduleNextPoll();
  }
}

function initializeDashboard() {
  const refreshButton = $("refreshButton");
  if (refreshButton) {
    refreshButton.addEventListener("click", () => {
      window.clearTimeout(state.pollTimer);
      fetchSensorData({ manual: true });
    });
  }

  if (state.mode === "demo") {
    state.currentRecord = makeDemoData();
    renderAll();
  } else {
    renderAll();
    fetchSensorData();
  }

  // Recalculate freshness labels between network polls without requesting duplicate data.
  window.setInterval(() => renderAll(), 1000);
}

document.addEventListener("DOMContentLoaded", initializeDashboard);
