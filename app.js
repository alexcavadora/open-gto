import { request, createServer } from "http";
import { MongoClient } from "mongodb";
import { guanajuatoCities, cityCoordinatesMap } from "./cities.js";
import { hostname } from "os";

// Configuration
const config = {
  mongo: {
    url: process.env.MONGO_URL || "mongodb://mongodb:27017/weatherData",
    dbName: "weatherData",
    collections: {
      current: "currentWeather",
      historical: "historicalWeather",
    },
  },
  server: {
    port: process.env.PORT || 3000,
  },
  cache: {
    duration: 60 * 60 * 1000, // 1 hour for current weather
    historicalDuration: 30 * 24 * 60 * 60 * 1000, // 30 days for historical data
  },
  openMeteo: {
    hist_hostname: "archive-api.open-meteo.com",
    hostname: "api.open-meteo.com",
    basePath: "/v1/forecast",
    historicalBasePath: "/v1/archive",
  },
};

// MongoDB client initialization
const client = new MongoClient(config.mongo.url);
let db;

// Utility function to validate coordinates
function validateCoordinates(lat, lon) {
  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);

  if (isNaN(latitude) || isNaN(longitude)) {
    return { valid: false, message: "Coordinates must be valid numbers" };
  }

  if (latitude < -90 || latitude > 90) {
    return {
      valid: false,
      message: "Latitude must be between -90 and 90 degrees",
    };
  }

  if (longitude < -180 || longitude > 180) {
    return {
      valid: false,
      message: "Longitude must be between -180 and 180 degrees",
    };
  }

  return { valid: true, latitude, longitude };
}

// Check if coordinates belong to a Guanajuato city
function isGuanajuatoCity(lat, lon) {
  const key = `${parseFloat(lat).toFixed(6)},${parseFloat(lon).toFixed(6)}`;
  return cityCoordinatesMap.has(key);
}

// Initialize MongoDB connections and indexes
async function connectToMongo() {
  try {
    await client.connect();
    console.log("Connected successfully to MongoDB");
    db = client.db(config.mongo.dbName);

    // Create indexes for current weather
    const currentCollection = db.collection(config.mongo.collections.current);
    await currentCollection.createIndex({
      lat: 1,
      lon: 1,
      timestamp: -1,
    });

    // Create indexes for historical weather
    const historicalCollection = db.collection(
      config.mongo.collections.historical,
    );
    await historicalCollection.createIndex({
      lat: 1,
      lon: 1,
      date: -1,
    });
    await historicalCollection.createIndex({ cityId: 1 });

    return db;
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
    throw error;
  }
}

// Function to get cached current weather data
async function getCachedWeatherData(lat, lon) {
  try {
    const collection = db.collection(config.mongo.collections.current);
    const oneHourAgo = new Date(Date.now() - config.cache.duration);

    const cachedData = await collection.findOne({
      lat: lat,
      lon: lon,
      timestamp: { $gte: oneHourAgo },
    });

    return cachedData;
  } catch (error) {
    console.error("Error retrieving cached data:", error);
    throw error;
  }
}

// Function to store current weather data
async function storeWeatherData(lat, lon, weatherData, cityId = null) {
  try {
    const collection = db.collection(config.mongo.collections.current);
    const document = {
      lat: lat,
      lon: lon,
      data: weatherData,
      timestamp: new Date(),
    };

    if (cityId) {
      document.cityId = cityId;
    }

    const result = await collection.insertOne(document);
    return result;
  } catch (error) {
    console.error("Error storing weather data:", error);
    throw error;
  }
}

// Function to fetch current weather from OpenMeteo
function fetchWeatherData(lat, lon) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: config.openMeteo.hostname,
      path: `${config.openMeteo.basePath}?latitude=${lat}&longitude=${lon}&current_weather=true`,
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

          if (res.statusCode !== 200) {
            reject(
              new Error(
                `OpenMeteo API error: ${jsonData.reason || "Unknown error"}`,
              ),
            );
            return;
          }

          resolve(jsonData);
        } catch (error) {
          reject(
            new Error(`Failed to parse OpenMeteo response: ${error.message}`),
          );
        }
      });
    });

    req.on("error", (error) => {
      reject(new Error(`OpenMeteo request failed: ${error.message}`));
    });

    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    req.end();
  });
}

// Function to fetch historical weather data
async function fetchHistoricalWeather(lat, lon, startDate, endDate) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: config.openMeteo.hist_hostname,
      path: `${config.openMeteo.historicalBasePath}?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&hourly=temperature_2m,precipitation&timezones=auto`,
      method: "GET",
    };

    // Imprime el path en la consola
    // console.log(`Request path: ${options.hostname}${options.path}`);

    const req = request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const jsonData = JSON.parse(data);

          if (res.statusCode !== 200) {
            reject(
              new Error(
                `OpenMeteo API error: ${jsonData.reason || "Unknown error"}`,
              ),
            );
            return;
          }

          resolve(jsonData);
        } catch (error) {
          reject(
            new Error(`Failed to parse OpenMeteo response: ${error.message}`),
          );
        }
      });
    });

    req.on("error", (error) => {
      reject(new Error(`OpenMeteo request failed: ${error.message}`));
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    req.end();
  });
}

// Function to store historical weather data
async function storeHistoricalWeather(cityData, weatherData) {
  try {
    const collection = db.collection(config.mongo.collections.historical);
    const document = {
      cityId: cityData.id,
      cityName: cityData.name,
      lat: cityData.coord.lat,
      lon: cityData.coord.lon,
      data: weatherData,
      timestamp: new Date(),
    };

    const result = await collection.insertOne(document);
    return result;
  } catch (error) {
    console.error("Error storing historical weather data:", error);
    throw error;
  }
}

// Function to fetch historical data for all cities
async function fetchAllCitiesHistoricalData() {
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 5);
  const endDate = new Date();

  const startDateStr = startDate.toISOString().split("T")[0];
  const endDateStr = endDate.toISOString().split("T")[0];

  console.log(
    `Starting historical data fetch for all cities from ${startDateStr} to ${endDateStr}`,
  );

  for (const city of guanajuatoCities) {
    try {
      console.log(`Fetching historical data for ${city.name}`);
      const weatherData = await fetchHistoricalWeather(
        city.coord.lat,
        city.coord.lon,
        startDateStr,
        endDateStr,
      );

      await storeHistoricalWeather(city, weatherData);
      console.log(`Successfully stored historical data for ${city.name}`);

      // Sleep for 1 second to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`Error fetching historical data for ${city.name}:`, error);
    }
  }

  console.log("Completed historical data fetch for all cities");
}

// Create HTTP server
const server = createServer(async (req, res) => {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check endpoint
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "OK" }));
    return;
  }

  // Endpoint to trigger historical data fetch
  if (req.url === "/api/fetch-historical" && req.method === "POST") {
    try {
      // Start the fetch process
      fetchAllCitiesHistoricalData().catch((error) =>
        console.error("Error in historical data fetch:", error),
      );

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          message: "Historical data fetch started",
          note: "This process runs in the background and may take several hours to complete",
        }),
      );
      return;
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "Failed to start historical data fetch" }),
      );
      return;
    }
  }

  // Weather data endpoint
  if (req.method === "GET" && req.url.startsWith("/api/weather")) {
    try {
      const urlParams = new URL(req.url, `http://${req.headers.host}`);
      const lat = urlParams.searchParams.get("lat");
      const lon = urlParams.searchParams.get("lon");

      // Validate coordinates
      const validation = validateCoordinates(lat, lon);
      if (!validation.valid) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: validation.message }));
        return;
      }

      const { latitude, longitude } = validation;

      // Check if it's a Guanajuato city
      const isLocalCity = isGuanajuatoCity(latitude, longitude);

      if (isLocalCity) {
        // Check cache first
        const cachedData = await getCachedWeatherData(latitude, longitude);

        if (cachedData) {
          console.log(
            `Serving cached data for coordinates: ${latitude}, ${longitude}`,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              source: "cache",
              timestamp: cachedData.timestamp,
              data: cachedData.data,
            }),
          );
          return;
        }
      }

      // If not in cache or not a local city, fetch from OpenMeteo
      console.log(
        `Fetching fresh data from OpenMeteo for coordinates: ${latitude}, ${longitude}`,
      );
      const weatherData = await fetchWeatherData(latitude, longitude);

      // Only store in MongoDB if it's a Guanajuato city
      if (isLocalCity) {
        const cityKey = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
        const city = cityCoordinatesMap.get(cityKey);
        await storeWeatherData(latitude, longitude, weatherData, city.id);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          source: "api",
          timestamp: new Date(),
          data: weatherData,
          cached: isLocalCity,
        }),
      );
    } catch (error) {
      console.error("Error handling request:", error);

      const statusCode = error.message.includes("OpenMeteo") ? 502 : 500;
      const errorMessage =
        process.env.NODE_ENV === "production"
          ? "Internal server error"
          : error.message;

      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errorMessage }));
    }
  } else {
    // Handle unknown routes
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Not found",
        availableEndpoints: {
          weather: "/api/weather?lat={latitude}&lon={longitude}",
          historical: "/api/fetch-historical (POST)",
          health: "/health",
        },
      }),
    );
  }
});

// Graceful shutdown handling
function handleShutdown() {
  console.log("Shutting down gracefully...");

  server.close(async () => {
    console.log("HTTP server closed");
    try {
      await client.close();
      console.log("MongoDB connection closed");
      process.exit(0);
    } catch (error) {
      console.error("Error during shutdown:", error);
      process.exit(1);
    }
  });

  // Force close after 10 seconds
  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", handleShutdown);
process.on("SIGINT", handleShutdown);

// Start server
const PORT = config.server.port;

// Connect to MongoDB then start server
connectToMongo()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
  });
