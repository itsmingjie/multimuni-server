import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 8080;

// ------------------------------
// 10-second in-memory cache
// ------------------------------
const CACHE_TTL_MS = 10 * 1000;
const agencyCache = new Map(); // key: "SF:apikey" -> { timestamp, data }

// ------------------------------
// Helpers
// ------------------------------

function normalizeStopRef(raw) {
  if (!raw) return "";
  return String(raw).trim().toUpperCase().replace(/^[A-Z]+_/, "");
}

function isRealtime(visit) {
  const rec = visit?.RecordedAtTime;
  const veh = visit?.MonitoredVehicleJourney?.VehicleRef;
  return rec && !rec.startsWith("1970") && veh && veh !== "" && veh !== null;
}

function isScheduleOnly(visit) {
  return !isRealtime(visit);
}

// Output reducer — keep ONLY fields needed for TRMNL
function simplifyVisit(visit) {
  const mj = visit.MonitoredVehicleJourney || {};
  const mc = mj.MonitoredCall || {};

  return {
    MonitoredVehicleJourney: {
      MonitoredCall: {
        StopPointRef: mc.StopPointRef || "",
        StopPointName: mc.StopPointName || "",
        DestinationDisplay: mc.DestinationDisplay || "",
        LineRef: mj.LineRef || "",
        AimedArrivalTime: mc.AimedArrivalTime || null,
        ExpectedArrivalTime: mc.ExpectedArrivalTime || null,
        AimedDepartureTime: mc.AimedDepartureTime || null,
        ExpectedDepartureTime: mc.ExpectedDepartureTime || null
      }
    }
  };
}

// Fetch all real-time + scheduled predictions for the entire agency
async function fetchAgency(agencyId, apiKey) {
  const cacheKey = `${agencyId}:${apiKey}`;
  const now = Date.now();

  const cached = agencyCache.get(cacheKey);
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const url =
    `http://api.511.org/transit/StopMonitoring` +
    `?api_key=${encodeURIComponent(apiKey)}` +
    `&agency=${encodeURIComponent(agencyId)}` +
    `&format=json`;

  try {
    const res = await axios.get(url, {
      headers: { Accept: "application/json" }
    });

    // 511 sometimes wraps in `Siri`, sometimes not
    const root = res.data.Siri || res.data;
    const rows =
      root?.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit || [];

    agencyCache.set(cacheKey, { timestamp: Date.now(), data: rows });
    return rows;
  } catch (err) {
    console.error(`Error fetching agency ${agencyId}:`, err.message);
    return [];
  }
}

// ------------------------------
// Main Route
// ------------------------------

app.post("/screen", async (req, res) => {
  const { api_key, stops } = req.body;

  if (!api_key) return res.status(400).json({ error: "Missing api_key" });
  if (!stops) return res.status(400).json({ error: "Missing stops list" });

  // Parse "SF:14608, SF:14609"
  const desiredStops = {};
  stops
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(pair => {
      const [agencyRaw, codeRaw] = pair.split(":");
      if (!agencyRaw || !codeRaw) return;
      const agency = agencyRaw.trim().toUpperCase();
      const code = codeRaw.trim().toUpperCase();
      if (!desiredStops[agency]) desiredStops[agency] = new Set();
      desiredStops[agency].add(code);
    });

  const agencies = Object.keys(desiredStops);

  try {
    // One fetch per agency
    const results = await Promise.all(
      agencies.map(async agencyId => {
        const rows = await fetchAgency(agencyId, api_key);
        const wantedStops = desiredStops[agencyId];

        // Filter by stop code
        const filtered = rows.filter(v => {
          const mc = v.MonitoredVehicleJourney?.MonitoredCall || {};
          const ref =
            mc.StopPointRef ||
            v.MonitoringRef ||
            mc.StopPointCode ||
            mc.StopCode ||
            "";
          const norm = normalizeStopRef(ref);
          return (
            wantedStops.has(norm) ||
            wantedStops.has(ref.toString().toUpperCase())
          );
        });

        // Separate real-time vs scheduled
        const realtime = filtered.filter(isRealtime);
        const schedule = filtered.filter(isScheduleOnly);

        if (realtime.length > 0) {
          return realtime.map(simplifyVisit);
        } else if (schedule.length > 0) {
          // Option B: pick the nearest scheduled prediction only
          schedule.sort((a, b) => {
            const ta = new Date(
              a.MonitoredVehicleJourney?.MonitoredCall?.ExpectedArrivalTime ||
                a.MonitoredVehicleJourney?.MonitoredCall?.AimedArrivalTime
            );
            const tb = new Date(
              b.MonitoredVehicleJourney?.MonitoredCall?.ExpectedArrivalTime ||
                b.MonitoredVehicleJourney?.MonitoredCall?.AimedArrivalTime
            );
            return ta - tb;
          });
          return [simplifyVisit(schedule[0])];
        }

        return [];
      })
    );

    // Flatten and chronological sort
    const merged = results.flat();

    merged.sort((a, b) => {
      const ta = new Date(
        a.MonitoredVehicleJourney.MonitoredCall.ExpectedArrivalTime ||
          a.MonitoredVehicleJourney.MonitoredCall.AimedArrivalTime
      );
      const tb = new Date(
        b.MonitoredVehicleJourney.MonitoredCall.ExpectedArrivalTime ||
          b.MonitoredVehicleJourney.MonitoredCall.AimedArrivalTime
      );
      return ta - tb;
    });

    res.json({
      ServiceDelivery: {
        StopMonitoringDelivery: {
          MonitoredStopVisit: merged
        }
      }
    });
  } catch (err) {
    console.error("Unhandled error in /screen:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------

app.listen(PORT, () => {
  console.log(`Minimal MultiMuni backend running on ${PORT}`);
});
