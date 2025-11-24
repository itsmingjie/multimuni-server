import express from "express";
import fetch from "node-fetch";

// In-memory cache: { key: { timestamp, data } }
const cache = {};
const app = express();

// ----------------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ----------------------------------------------------------------------
const API_KEY = process.env.API_KEY;
const STOPS = process.env.STOPS || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const FREQUENCY_MINUTES = parseInt(process.env.FREQUENCY_MINUTES || "1", 10);

// ----------------------------------------------------------------------
// PARSE STOP LIST
// Example: "SF:14609,SF:14608,GG:40033"
// => { SF: ["14609","14608"], GG: ["40033"] }
// ----------------------------------------------------------------------
function parseStops(stopString) {
  const operators = {};
  stopString
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(pair => {
      const [op, stop] = pair.split(":");
      if (!operators[op]) operators[op] = [];
      operators[op].push(stop);
    });
  return operators;
}

// ----------------------------------------------------------------------
// CACHED FETCH (60 seconds)
// ----------------------------------------------------------------------
async function cachedFetch(url) {
  const now = Date.now();
  const hit = cache[url];

  if (hit && now - hit.timestamp < 60000) {
    return hit.data;
  }

  const res = await fetch(url);
  const json = await res.json();

  cache[url] = { timestamp: now, data: json };
  return json;
}

// ----------------------------------------------------------------------
// FETCH A SINGLE OPERATOR (ALL STOPS AT ONCE)
// Using fallback: SFMTA uses &stopCode=, GGT uses &stopCode=
// If operator requires per-stop calls, fallback to multi-call
// ----------------------------------------------------------------------
async function fetchOperator(operatorId, stops) {
  const joined = stops.join(",");

  const url = `https://api.511.org/transit/StopMonitoring?api_key=${API_KEY}&agency=${operatorId}&stopCode=${joined}&format=json`;

  try {
    const data = await cachedFetch(url);
    const visits =
      data?.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit || [];
    return visits;
  } catch (err) {
    console.error("Operator fetch failed, falling back per-stop", operatorId, err);
  }

  // Fallback: fetch each stop individually
  const perStop = await Promise.all(
    stops.map(async stopCode => {
      const u = `https://api.511.org/transit/StopMonitoring?api_key=${API_KEY}&agency=${operatorId}&stopCode=${stopCode}&format=json`;
      try {
        const d = await cachedFetch(u);
        return (
          d?.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit || []
        );
      } catch (e) {
        console.error("Single stop failed", operatorId, stopCode, e);
        return [];
      }
    })
  );

  return perStop.flat();
}

// ----------------------------------------------------------------------
// BUILD FINAL UNIVERSAL PAYLOAD { departures: [], lines: [] }
// ----------------------------------------------------------------------
function transformVisits(allVisits) {
  const departures = allVisits
    .map(v => {
      const j = v?.MonitoredVehicleJourney;
      const mc = j?.MonitoredCall;
      if (!j || !mc) return null;

      const line =
        j.LineRef ||
        j.PublishedLineName ||
        j.RouteRef ||
        null;

      return {
        stopRef: mc.StopPointRef || null,
        stopName: mc.StopPointName || null,
        destination: mc.DestinationDisplay || null,
        line,
        aimed: mc.AimedArrivalTime || null,
        expected: mc.ExpectedArrivalTime || mc.AimedArrivalTime || null
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        new Date(a.expected).getTime() -
        new Date(b.expected).getTime()
    );

  const lines = Array.from(
    new Set(departures.map(d => d.line).filter(Boolean))
  ).map(line => ({ line }));

  return { departures, lines };
}

// ----------------------------------------------------------------------
// PUSH TO WEBHOOK
// ----------------------------------------------------------------------
async function pushToWebhook() {
  console.log("Running scheduled update...");

  if (!API_KEY || !WEBHOOK_URL || !STOPS) {
    console.error("Missing required env vars (API_KEY, WEBHOOK_URL, STOPS)");
    return;
  }

  const operators = parseStops(STOPS);

  // Fetch all operators
  const visitArrays = await Promise.all(
    Object.entries(operators).map(([op, stops]) =>
      fetchOperator(op, stops)
    )
  );

  const allVisits = visitArrays.flat();
  const payload = transformVisits(allVisits);

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      console.error("Webhook push failed:", res.status, await res.text());
    } else {
      console.log("Webhook push OK", new Date().toISOString());
    }
  } catch (err) {
    console.error("Webhook push error:", err);
  }
}

// ----------------------------------------------------------------------
// SCHEDULED RUNNER (no HTTP routes needed)
// ----------------------------------------------------------------------
setInterval(pushToWebhook, FREQUENCY_MINUTES * 60 * 1000);

// Run immediately at boot
pushToWebhook();

// Dummy listener so Coolify marks service as “running”
app.get("/", (req, res) => res.send("Multimuni Webhook Push running"));
app.listen(process.env.PORT || 8080, () => {
  console.log("Server started");
});
