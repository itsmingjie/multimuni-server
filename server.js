import express from "express";

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY;
const STOPS = process.env.STOPS; // Example: "SF:14609,SF:14608,GG:40033"
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const FREQUENCY_MINUTES = parseInt(process.env.FREQUENCY_MINUTES || "5", 10);

/* ----------------------------------------------
   Fetch per operator+stop
---------------------------------------------- */
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
  } catch {
    return [];
  }
}

/* ----------------------------------------------
   Normalize down to minimal shape
---------------------------------------------- */
function slim(visits) {
  const result = [];

  for (const v of visits) {
    const mvj = v.MonitoredVehicleJourney;
    if (!mvj?.MonitoredCall) continue;

    const call = mvj.MonitoredCall;

    result.push({
      operator: mvj.OperatorRef,
      line: mvj.LineRef || mvj.PublishedLineName || "?",
      destination: call.DestinationDisplay || "?",
      expected: call.ExpectedDepartureTime || call.ExpectedArrivalTime
    });
  }

  return result;
}

/* ----------------------------------------------
   Build bottom "lines" summary (one per operator+line)
---------------------------------------------- */
function buildLines(dep) {
  const bucket = {};

  for (const d of dep) {
    const key = `${d.operator}:${d.line}`;
    if (!bucket[key]) bucket[key] = [];
    bucket[key].push(d);
  }

  // pick soonest departure per line
  return Object.values(bucket)
    .map(list => list.sort((a, b) => new Date(a.expected) - new Date(b.expected))[0])
    .sort((a, b) => new Date(a.expected) - new Date(b.expected));
}

/* ----------------------------------------------
   PUSH LOGIC
---------------------------------------------- */
async function refreshAndPush() {
  const stopList = STOPS.split(",").map(s => s.trim());
  let all = [];

  for (const item of stopList) {
    const [op, stop] = item.split(":");
    if (!op || !stop) continue;

    const visits = await fetchOperator(op, stop);
    all.push(...slim(visits));
  }

  // Sort by time
  all = all.sort((a, b) => new Date(a.expected) - new Date(b.expected));

  // Minimal payload: next 3 + line summaries
  const next3 = all.slice(0, 3);
  const lines = buildLines(all);

  const payload = {
    merge_variables: { next3, lines },
    merge_strategy: "replace"
  };

  // Enforce 2 KB
  const size = Buffer.byteLength(JSON.stringify(payload), "utf8");
  console.log("Payload size:", size, "bytes");
  if (size > 2000) {
    console.error("OVER 2KB, trimming…");

    // Emergency trim: cut destinations + slice lines
    next3.forEach(d => { d.destination = d.destination.slice(0, 12); });
    while (Buffer.byteLength(JSON.stringify(payload), "utf8") > 2000 && lines.length > 4)
      lines.pop();
  }

  // Push to TRMNL
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const txt = await res.text();
    console.log("Push result:", res.status, txt);
  } catch (e) {
    console.error("Webhook push failed:", e);
  }
}

/* ---------------------------------------------- */
app.post("/push", async (req, res) => {
  await refreshAndPush();
  res.send({ ok: true });
});

/* ---------------------------------------------- */
setInterval(refreshAndPush, FREQUENCY_MINUTES * 60000);
refreshAndPush();

app.listen(8080, () => console.log("Server running"));
