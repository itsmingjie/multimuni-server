import express from "express";

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY;
const STOPS = process.env.STOPS; // "SF:14608,SF:14609,GG:40033"
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const FREQUENCY_MINUTES = Number(process.env.FREQUENCY_MINUTES || 5);

if (!API_KEY || !STOPS || !WEBHOOK_URL) {
  console.error("Missing env vars: API_KEY, STOPS, WEBHOOK_URL required.");
  process.exit(1);
}

function parseStops(raw) {
  return raw.split(",").map(s => {
    const [op, stop] = s.trim().split(":");
    return { operator: op, stopCode: stop };
  });
}

async function fetchStop(op, stopCode) {
  try {
    const url = `https://api.511.org/transit/StopMonitoring?api_key=${API_KEY}&agency=${op}&stopcode=${stopCode}&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error("Fetch error:", op, stopCode, e);
    return null;
  }
}

function extractDepartures(raw) {
  if (!raw?.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit) return [];
  return raw.ServiceDelivery.StopMonitoringDelivery.MonitoredStopVisit.map(v => {
    const mvj = v.MonitoredVehicleJourney ?? {};
    const mc = mvj.MonitoredCall ?? {};
    return {
      line: mvj.LineRef || mvj.PublishedLineName || null,
      destination: mc.DestinationDisplay || mvj.DestinationName || "",
      expected: mc.ExpectedArrivalTime || mc.AimedArrivalTime,
      operator: mvj.OperatorRef || null
    };
  }).filter(d => d.expected && d.line);
}

function pruneDestination(name = "") {
  // Shorten big GGT names
  return name
    .replace("San Francisco ", "")
    .replace("Salesforce Transit Center", "Salesforce TC")
    .trim();
}

function compactify(list) {
  return list.map(d => ({
    line: d.line,
    destination: pruneDestination(d.destination),
    expected: d.expected
  }));
}

async function pushToWebhook(data) {
  const payload = {
    merge_variables: data
  };

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const t = await res.text();
      console.error("Webhook error:", res.status, t);
    }
  } catch (e) {
    console.error("Webhook push failed:", e);
  }
}

async function generateAndPush() {
  const stops = parseStops(STOPS);

  let all = [];
  for (const s of stops) {
    const json = await fetchStop(s.operator, s.stopCode);
    const dep = extractDepartures(json);
    all.push(...dep);
  }

  // Sort all departures globally
  all.sort((a, b) => new Date(a.expected) - new Date(b.expected));

  const next3 = compactify(all.slice(0, 3));

  const muni = compactify(all.filter(d => d.operator === "SF").slice(0, 3));
  const ggt  = compactify(all.filter(d => d.operator === "GG").slice(0, 3));

  await pushToWebhook({
    departures: next3,
    lines_sf: muni,
    lines_gg: ggt
  });
}

// PUBLIC ENDPOINT TO TRIGGER PUSH
app.get("/trigger", async (req, res) => {
  await generateAndPush();
  res.json({ ok: true });
});

// Start polling timer
setInterval(generateAndPush, FREQUENCY_MINUTES * 60 * 1000);

// Start server
app.listen(8080, () => console.log("Server running + webhook pusher active"));
