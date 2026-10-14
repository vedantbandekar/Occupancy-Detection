# SmartRoom — Live IoT Monitoring Dashboard

A responsive, vanilla HTML/CSS/JavaScript dashboard for the SmartRoom ESP32 environmental-monitoring prototype. It is designed for the first 40% milestone: show presence, temperature, humidity, air-quality output, TVOC, eCO₂ estimate, ambient light, sensor availability, and gateway connectivity—without implying that future light/fan automation is working.

## Current preview status

The app starts in **Demo mode** (`MODE: "demo"` in `script.js`). The displayed values are illustrative sample data and are marked throughout the UI. They are **not readings from an ESP32**, and the preview does not claim that any physical sensor is connected. No hardware is available in this workspace, so live ESP32 integration and the hardware test scenarios have not been verified here.

## Open in VS Code or Antigravity

1. Download and extract the `SmartRoom-Dashboard` folder.
2. In VS Code or Antigravity, choose **Open Folder** and select `SmartRoom-Dashboard`.
3. Edit `index.html`, `style.css`, and `script.js` directly. There are no npm packages to install.
4. To preview, use the IDE's Live Server extension if available, or start the simple local server below from the project terminal.

## Run the dashboard

The project uses only browser-native HTML, CSS, and JavaScript. No build step, dependency install, database, or external CDN is required.

From this folder, run a local static server, for example:

```bash
python3 -m http.server 8000 --bind 0.0.0.0
```

The project also includes `start-preview.sh` for macOS/Linux and `start-preview.bat` for Windows. These launch the same simple server from the project folder.

Open `http://localhost:8000` in a browser (or use the workspace live preview). Avoid opening `index.html` through `file://`; browsers restrict network requests from local files.

## Switch to live hardware mode

1. Confirm the ESP32 is serving an HTTP `GET` endpoint that returns valid JSON.
2. Open `script.js` and update the configuration near the top:

   ```js
   MODE: "live",
   API_ENDPOINT: "http://<ESP32-address>/api/status",
   POLL_INTERVAL_MS: 2500,
   REQUEST_TIMEOUT_MS: 5000,
   MAX_DATA_AGE_MS: 15000,
   ```

   Replace `<ESP32-address>` and the path with your actual endpoint. Do not add Wi-Fi passwords, tokens, or other secrets to frontend code. If the frontend is served by the ESP32 itself, a same-origin relative endpoint such as `/api/status` may be appropriate.

3. Adjust the field mapping **only inside `normalizeSensorData(rawData)`** in `script.js` if the firmware uses different field names, nesting, or units. That adapter converts the firmware response into the dashboard's internal data model.
4. Test with the browser's Network/Console tools. On a failed request, live mode shows unavailable values or retains the last valid values with an explicit stale/error state; it never silently falls back to demo values.

### Provisional JSON shape

This is a contract example, not a claim about existing firmware. Values below are illustrative only:

```json
{
  "device_id": "room_01",
  "timestamp": "2026-10-11T16:30:00Z",
  "occupancy": {
    "occupied": true,
    "available": true
  },
  "environment": {
    "temperature_c": 27.4,
    "humidity_percent": 61.2,
    "tvoc_ppb": 143,
    "eco2_ppm": 650,
    "aqi_output": 2
  },
  "light": {
    "illuminance_lux": 284
  },
  "sensors": {
    "LD2412": { "available": true },
    "AHT21": { "available": true },
    "ENS160": { "available": true },
    "OPT3004": { "available": true }
  },
  "system": {
    "connected": true,
    "wifi_connected": true,
    "firmware_version": "<reported-version>"
  }
}
```

Only include fields that firmware actually measures or reports. Missing or invalid values render as unavailable—not as zero. The frontend expects temperature in °C, humidity in percent, illuminance in lux, TVOC in ppb, and eCO₂ in ppm. Convert units in `normalizeSensorData()` if firmware uses different units. A valid ISO-8601 `timestamp` is treated as measurement time; if it is omitted, the dashboard labels the browser response-receipt time instead.

### AQI interpretation is deliberately gated

The ENS160's native AQI output is not automatically the application's five-level scale. By default, live `aqi_level` is displayed as an AQI output with the human-friendly application mapping marked **pending**. The UI will show `Excellent / Good / Moderate / Poor / Very poor` and a level bar only after all of the following are true:

- The firmware/application explicitly maps its input to an application level from 1–5.
- The field is documented as that application level (prefer `app_aqi_level`).
- `AQI_LEVEL_MAPPING_CONFIRMED` is changed to `true` in `script.js`.

The level labels are an application presentation scale; no ENS160 manufacturer threshold is asserted. The sample level shown in Demo mode is illustrative.

## Status and stale-data behavior

- Sensor Online/Offline status comes from individual firmware sensor-health entries (`sensors` or `sensor_status`). Wi-Fi or ESP32 connectivity alone does not mark sensors Online.
- If per-sensor health is absent, the UI reports **Unknown** even when a reading is present.
- Occupied, not occupied, and presence-unavailable are distinct states. A communication failure is never treated as an empty room.
- `MAX_DATA_AGE_MS` determines when the last measurement becomes stale. The response time is used only when the device did not provide a usable timestamp.
- Polls are scheduled after the previous request finishes; overlapping fetches are prevented. The refresh control requests a fresh response immediately.
- Temperature, humidity, and light interpretations use editable **application-defined display bands** in `CONFIG.INTERPRETATION_BANDS`. These are not manufacturer, health, or safety thresholds.

## Browser networking and CORS

The browser and ESP32 must be reachable on a suitable local network. A browser request from another origin may require the ESP32 to return appropriate CORS headers. HTTPS-hosted pages may also block requests to an HTTP-only device as mixed content. Prefer serving the dashboard and endpoint from the same origin, or use a suitable local development proxy. Do not disable browser security to work around CORS, and do not expose network credentials in HTML or JavaScript.

## Files

- `index.html` — dashboard structure and accessible status regions.
- `style.css` — responsive navy sidebar, light telemetry cards, status styles, and mobile layouts.
- `script.js` — mode configuration, endpoint polling, JSON validation/normalization, interpretations, freshness, and rendering.
- `README.md` — setup and ESP32 integration notes.

## Scope

This milestone is monitoring-only. It has no login/authentication, account pages, cloud storage, history, notifications, gas-leak alarms, or light/fan controls. TVOC is an aggregate VOC indicator, not gas identification or certified gas-leak detection. ENS160 eCO₂ is an estimate, not a direct measurement from a dedicated CO₂ sensor.
