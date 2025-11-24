import express from "express";

const cache = {};
const app = express();
app.use(express.json());

// ----------------------------------------------------------------------
// ENV VARS
// ----------------------------------------------------------------------
const API_KEY = process.env.API_KEY;
const STOPS = process.env.STOPS || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const FREQUENCY_MINUTES = parseInt(process.env.FREQUENCY_MINUTES || "1", 10);

// ----------------------------------------------------------------------
// Helpers
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

async function fetchOperator(operatorId, stops) {
  const joined = stops.join(",");
  const url = `https://api.511.org/transit/StopMonitoring?api_key=${API_KEY}&agency=${operatorId}&stopCode=${joined}&format=json`;

  try {
    const data = await cachedFetch(url);
    return (
      data?.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit || []
    );
  } catch (err) {
    console.error("Batch fetch failed:", operatorId, err);
  }

  // fallback per-stop
  const perStop = await Promise.all(
    stops.map(async stopCode => {
      const u = `https://api.511.org/transit/StopMonitoring?api_key=${API_KEY}&agency=${operatorId}&stopCode=${stopCode}&format=json`;
      try {
        const d = await cachedFetch(u);
        return (
          d?.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit || []
        );
      } catch (e) {
        console.error("Single-stop failed:", operatorId, stopCode, e);
        return [];
      }
    })
  );

  return perStop.flat();
}

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

async function pushOnce() {
  if (!API_KEY || !WEBHOOK_URL || !STOPS) {
    console.error("Missing env vars");
    return { ok: false, error: "Missing env vars" };
  }

  const operators = parseStops(STOPS);
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

    const txt = await res.text();
    if (!res.ok) {
      console.error("Webhook error:", res.status, txt);
      return { ok: false, status: res.status, body: txt };
    }

    console.log("Webhook push OK", new Date().toISOString());
    return { ok: true };
  } catch (err) {
    console.error("Webhook push exception:", err);
    return { ok: false, error: err.message };
  }
}

// ----------------------------------------------------------------------
// NEW: Force push endpoint
// ----------------------------------------------------------------------
app.post("/force-push", async (req, res) => {
  console.log("Manual force push triggered");
  const result = await pushOnce();
  res.json(result);
});

// ----------------------------------------------------------------------
// Scheduler
// ----------------------------------------------------------------------
setInterval(pushOnce, FREQUENCY_MINUTES * 60 * 1000);
pushOnce(); // immediate on boot

// Dummy listener so Coolify keeps service alive
app.get("/", (req, res) => res.send("Multimuni Webhook Push running"));
app.listen(process.env.PORT || 8080, () =>
  console.log("Server started")
);
