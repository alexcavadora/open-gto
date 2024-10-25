import { request, createServer } from "http";
import { MongoClient } from "mongodb";
import { guanajuatoCities } from "./cities.js";

const cityCoordinatesMap = new Map(
  guanajuatoCities.map((city) => [
    `${city.coord.lat.toFixed(6)},${city.coord.lon.toFixed(6)}`,
    city,
  ]),
);

const config = {
  mongo: {
    url: process.env.MONGO_URL || "mongodb://mongodb:27017/weatherData",
    dbName: "weatherData",
    collection: "weather",
  },
  server: {
    port: process.env.PORT || 3000,
  },
  openMeteo: {
    hostname: "api.open-meteo.com",
    historicalHostname: "archive-api.open-meteo.com",
    basePath: "/v1/forecast",
    historicalBasePath: "/v1/archive",
  },
};

const client = new MongoClient(config.mongo.url);
let db;

// Validate coordinates
function validateCoordinates(lat, lon) {
  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);

  if (isNaN(latitude) || isNaN(longitude)) {
    return { valid: false, message: "Invalid coordinates" };
  }

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { valid: false, message: "Coordinates out of range" };
  }

  return { valid: true, latitude, longitude };
}

// Fetch weather data from OpenMeteo
function fetchWeatherData(lat, lon) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: config.openMeteo.hostname,
        path: `${config.openMeteo.basePath}?latitude=${lat}&longitude=${lon}&current_weather=true&timezones=auto`,
        method: "GET",
        timeout: 5000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(json.reason || "API Error"));
              return;
            }
            resolve(json);
          } catch (error) {
            reject(new Error("Failed to parse API response"));
          }
        });
      },
    );

    req.on("error", (error) =>
      reject(new Error(`Request failed: ${error.message}`)),
    );
    req.end();
  });
}

// MongoDB operations
async function connectToMongo() {
  await client.connect();
  console.log("Connected to MongoDB");
  db = client.db(config.mongo.dbName);

  const collection = db.collection(config.mongo.collection);
  await collection.createIndex({
    lat: 1,
    lon: 1,
    dataType: 1,
    timestamp: -1,
  });

  return db;
}

async function getWeatherData(lat, lon, dataType = "current") {
  const collection = db.collection(config.mongo.collection);
  const cacheWindow = dataType === "current" ? 60 * 60 * 1000 : Infinity;

  return collection.findOne({
    lat,
    lon,
    dataType,
    timestamp: { $gte: new Date(Date.now() - cacheWindow) },
  });
}

async function storeWeatherData(lat, lon, data, dataType = "current") {
  const collection = db.collection(config.mongo.collection);
  const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  const city = cityCoordinatesMap.get(key);

  return collection.insertOne({
    lat,
    lon,
    data,
    dataType,
    cityId: city?.id || null,
    timestamp: new Date(),
  });
}

// Fetch complete cache data
async function getCompleteCache() {
  const collection = db.collection(config.mongo.collection);
  return collection.find({}).toArray();
}

// HTTP server
const server = createServer(async (req, res) => {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "OK" }));
    return;
  }

  // Fetch all cache data
  if (req.url === "/api/cache" && req.method === "GET") {
    try {
      const cacheData = await getCompleteCache();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cache: cacheData }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to retrieve cache data" }));
    }
    return;
  }

  // Weather data endpoint
  if (req.url.startsWith("/api/weather") && req.method === "GET") {
    try {
      const params = new URL(req.url, `http://${req.headers.host}`)
        .searchParams;
      const lat = params.get("lat");
      const lon = params.get("lon");

      const validation = validateCoordinates(lat, lon);
      if (!validation.valid) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: validation.message }));
        return;
      }

      // Check cache
      const cached = await getWeatherData(
        validation.latitude,
        validation.longitude,
      );
      if (cached) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            source: "cache",
            timestamp: cached.timestamp,
            data: cached.data,
          }),
        );
        return;
      }

      // Fetch fresh data
      const weatherData = await fetchWeatherData(
        validation.latitude,
        validation.longitude,
      );
      await storeWeatherData(
        validation.latitude,
        validation.longitude,
        weatherData,
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          source: "api",
          timestamp: new Date(),
          data: weatherData,
        }),
      );
    } catch (error) {
      const statusCode = error.message.includes("API Error") ? 502 : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            process.env.NODE_ENV === "production"
              ? "Server error"
              : error.message,
        }),
      );
    }
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Not found",
        endpoints: {
          weather: "/api/weather?lat={latitude}&lon={longitude}",
          cache: "/api/cache",
          health: "/health",
        },
      }),
    );
  }
});

function shutdown() {
  console.log("Shutting down...");
  server.close(async () => {
    try {
      await client.close();
      process.exit(0);
    } catch (error) {
      console.error("Shutdown error:", error);
      process.exit(1);
    }
  });

  setTimeout(() => {
    console.error("Force shutdown");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

connectToMongo()
  .then(() => {
    server.listen(config.server.port, () => {
      console.log(`Server running on port ${config.server.port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
