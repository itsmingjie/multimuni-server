import express from "express";

const app = express();
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
    const start = Date.now();
    const method = req.method;
    const path = req.path;
    
    // Log incoming request with snippet
    const reqSnippet = JSON.stringify(req.body).substring(0, 100);
    console.log(`[${new Date().toISOString()}] → ${method} ${path} | Body: ${reqSnippet}`);
    
    // Intercept response
    const originalJson = res.json.bind(res);
    res.json = function(data) {
        const duration = Date.now() - start;
        const resSnippet = JSON.stringify(data).substring(0, 100);
        console.log(`[${new Date().toISOString()}] ← ${method} ${path} | ${res.statusCode} (${duration}ms) | Response: ${resSnippet}`);
        return originalJson(data);
    };
    
    next();
});

// ------------------------------------------------------
// 10-second simple cache
// ------------------------------------------------------
const cache = new Map();
const CACHE_TTL = 10 * 1000; // 10 seconds

function makeCacheKey(apiKey, operators) {
    return `${apiKey}:${operators.sort().join(",")}`;
}

function getCache(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL) {
        cache.delete(key);
        return null;
    }
    return entry.data;
}

function setCache(key, value) {
    cache.set(key, { timestamp: Date.now(), data: value });
}

// ------------------------------------------------------
// Fetch StopMonitoring for one operator
// ------------------------------------------------------
async function fetchOperator(apiKey, operatorId) {
    const url =
        `https://api.511.org/transit/StopMonitoring?api_key=${apiKey}` +
        `&agency=${operatorId}&format=json`;

    const res = await fetch(url);

    if (!res.ok) {
        console.warn(`511 API error for operator ${operatorId}:`, res.status);
        return [];
    }

    let json;
    try {
        json = await res.json();
    } catch (err) {
        console.warn("JSON parse failed:", err);
        return [];
    }

    return (
        json?.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit || []
    );
}

// ------------------------------------------------------
// POST /screen — TRMNL-compatible data
// ------------------------------------------------------
app.post("/screen", async (req, res) => {
    try {
        const { api_key, stops } = req.body;

        if (!api_key || !stops) {
            return res.status(400).json({
                error: "Missing required fields: api_key and stops"
            });
        }

        // Parse input list like: "SF:14609,SF:14608,GG:40033"
        const parsed = stops.split(",").map(s => s.trim());

        const operatorToStops = {};
        parsed.forEach(item => {
            const [op, stop] = item.split(":");
            if (!operatorToStops[op]) operatorToStops[op] = [];
            operatorToStops[op].push(stop);
        });

        const operators = Object.keys(operatorToStops);
        const cacheKey = makeCacheKey(api_key, operators);

        // --------------------------------------------------
        // Use cached results if available
        // --------------------------------------------------
        const cached = getCache(cacheKey);
        if (cached) {
            console.log(`[${new Date().toISOString()}] Cache HIT for operators: ${operators.join(", ")}`);
            return res.json(cached);
        }
        console.log(`[${new Date().toISOString()}] Cache MISS - fetching data for operators: ${operators.join(", ")}`);

        // --------------------------------------------------
        // Fetch data per operator (1 request per agency)
        // --------------------------------------------------
        let allVisits = [];

        for (const op of operators) {
            const rawVisits = await fetchOperator(api_key, op);
            const allowedStops = operatorToStops[op];

            const filtered = rawVisits.filter(v => {
                const stopRef =
                    v?.MonitoredVehicleJourney?.MonitoredCall?.StopPointRef;
                return stopRef && allowedStops.includes(stopRef);
            });

            allVisits.push(...filtered);
        }

        // --------------------------------------------------
        // Transform into minimal clean structure
        // --------------------------------------------------
        const departures = allVisits
            .map(v => {
                const journey = v?.MonitoredVehicleJourney;
                const mc = journey?.MonitoredCall;
                if (!journey || !mc) return null;

                const line =
                    journey.LineRef ??
                    journey.PublishedLineName ??
                    journey.RouteRef ??
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

        // --------------------------------------------------
        // Compute unique lines list
        // --------------------------------------------------
        const seen = new Set();
        const lines = [];

        for (const d of departures) {
            if (!d.line) continue;
            if (seen.has(d.line)) continue;

            lines.push({
                line: d.line,
                destination: d.destination,
                expected: d.expected
            });

            seen.add(d.line);
        }

        // Final TRMNL output shape
        const output = { departures, lines };

        setCache(cacheKey, output);
        return res.json(output);
    } catch (err) {
        console.error("Server error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ------------------------------------------------------
// Start server
// ------------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`MultiMuni server listening on port ${PORT}`);
});
