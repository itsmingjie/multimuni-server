import express from "express";

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY;
const STOPS = process.env.STOPS; // "SF:14609,SF:14608,GG:40033"
const WEBHOOK_URL = process.env.WEBHOOK_URL; // TRMNL merge_variables endpoint
const FREQUENCY_MINUTES = parseInt(process.env.FREQUENCY_MINUTES || "5", 10);

/* ---------------------------------------------------
   Helper: fetch all operators in parallel
--------------------------------------------------- */
async function fetchOperator(operator, stopCode) {
  const url =
    `https://api.511.org/transit/StopMonitoring` +
    `?api_key=${API_KEY}` +
    `&agency=${operator}` +
    `&stopcode=${stopCode}` +
    `&format=json`;

  try {
    const res = await fetch(url);
    const json = await res.json();
    return json?.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit || [];
  } catch (e) {
    console.error("Error fetching operator:", operator, e);
    return [];
  }
}

/* ---------------------------------------------------
   Helper: flatten & normalize MVJ objects
--------------------------------------------------- */
function normalizeResults(visits) {
  const results = [];

  for (const v of visits) {
    const mvj = v.MonitoredVehicleJourney;
    if (!mvj || !mvj.MonitoredCall) continue;

    const call = mvj.MonitoredCall;

    results.push({
      operator: mvj.OperatorRef,                          // "SF" or "GG"
      line: mvj.LineRef || mvj.PublishedLineName || "?",  // always something
      destination: call.DestinationDisplay || "?",        // always something
      stopRef: call.StopPointRef,
      stopName: call.StopPointName,
      aimed: call.AimedDepartureTime || call.AimedArrivalTime,
      expected: call.ExpectedDepartureTime || call.ExpectedArrivalTime,
    });
  }

  return results;
}

/* ---------------------------------------------------
   Helper: build "lines" summary section
   (Next soonest departure per (operator,line))
--------------------------------------------------- */
function buildLines(departures) {
  const bucket = {};

  for (const d of departures) {
    if (!d.operator || !d.line) continue;

    const key = `${d.operator}:${d.line}`;

    if (!bucket[key]) bucket[key] = [];
    bucket[key].push(d);
  }

  // Keep the earliest for each line
  const lines = Object.values(bucket).map(list =>
    list.sort((a, b) => new Date(a.expected) - new Date(b.expected))[0]
  );

  // Sort globally
  return lines.sort((a, b) => new Date(a.expected) - new Date(b.expected));
}

/* ---------------------------------------------------
   Main: refresh function
--------------------------------------------------- */
async function refreshAndPush() {
  console.log("Refreshing…");

  const stopList = STOPS.split(",").map(s => s.trim());
  const allVisits = [];

  for (const item of stopList) {
    const [operator, stop] = item.split(":");
    if (!operator || !stop) continue;

    const visits = await fetchOperator(operator, stop);
    const normalized = normalizeResults(visits);
    allVisits.push(...normalized);
  }

  // Sort departures
  const departures = allVisits.sort(
    (a, b) => new Date(a.expected) - new Date(b.expected)
  );

  // Build lines array (ensures Muni + GGT both included)
  const lines = buildLines(departures);

  // Payload to TRMNL
  const payload = {
    merge_variables: {
      departures,
      lines
    },
    merge_strategy: "replace"
  };

  console.log("Pushing to TRMNL:", JSON.stringify(payload, null, 2));

  // Send POST to webhook
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    if (!res.ok) {
      console.error("Webhook error:", res.status, text);
    } else {
      console.log("Webhook push success:", text);
    }
  } catch (e) {
    console.error("Webhook POST failed:", e);
  }
}

/* ---------------------------------------------------
   Express Routes
--------------------------------------------------- */
app.get("/", (req, res) => {
  res.send("Multimuni Webhook Pusher running.");
});

// Force push endpoint
app.post("/push", async (req, res) => {
  await refreshAndPush();
  res.send({ status: "ok", forced: true });
});

/* ---------------------------------------------------
   Interval timer
--------------------------------------------------- */
setInterval(refreshAndPush, FREQUENCY_MINUTES * 60 * 1000);
console.log("Server started");
refreshAndPush(); // initial trigger

/* --------------------------------------------------- */
app.listen(8080, () => {
  console.log("Listening on :8080");
});
