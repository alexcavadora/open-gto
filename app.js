import { request, createServer } from "http";
import { MongoClient } from "mongodb";

const url = process.env.MONGO_URL || "mongodb://mongodb:27017/weatherData";
const client = new MongoClient(url);
let db;

// Connect to MongoDB
async function connectToMongo() {
  try {
    await client.connect();
    console.log("Connected successfully to MongoDB");
    db = client.db("weatherData");
    return db;
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
    throw error;
  }
}

// Function to check cached weather data
async function getCachedWeatherData(lat, lon) {
  const collection = db.collection("weather");
  // Look for data not older than 1 hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const cachedData = await collection.findOne({
    lat: parseFloat(lat),
    lon: parseFloat(lon),
    timestamp: { $gte: oneHourAgo },
  });

  return cachedData;
}

// Function to fetch weather data from OpenMeteo
function fetchWeatherData(lat, lon) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.open-meteo.com",
      path: `/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`,
      method: "GET",
    };

    const req = request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const jsonData = JSON.parse(data);
          resolve(jsonData);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("error", (error) => {
      reject(error);
    });

    req.end();
  });
}

// Create HTTP server
const server = createServer(async (req, res) => {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/weather")) {
    try {
      const urlParams = new URL(req.url, `http://${req.headers.host}`);
      const lat = urlParams.searchParams.get("lat");
      const lon = urlParams.searchParams.get("lon");

      if (!lat || !lon) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Latitude and longitude are required" }),
        );
        return;
      }

      // Check cache first
      const cachedData = await getCachedWeatherData(lat, lon);

      if (cachedData) {
        console.log("Serving cached data");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(cachedData.data));
        return;
      }

      // If not in cache, fetch from OpenMeteo
      console.log("Fetching fresh data from OpenMeteo");
      const weatherData = await fetchWeatherData(lat, lon);

      // Store in MongoDB
      const weatherCollection = db.collection("weather");
      await weatherCollection.insertOne({
        lat: parseFloat(lat),
        lon: parseFloat(lon),
        data: weatherData,
        timestamp: new Date(),
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(weatherData));
    } catch (error) {
      console.error("Error handling request:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

// Start server
const PORT = process.env.PORT || 3000;

// Connect to MongoDB then start server
connectToMongo()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
