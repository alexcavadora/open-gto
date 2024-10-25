import { request, createServer } from "http";
const url = process.env.MONGO_URL; // Use the environment variable
import { MongoClient } from "mongodb";
const client = new MongoClient(url, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

async function connectToMongo() {
  try {
    await client.connect();
    console.log("Connected successfully to MongoDB");
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
  }
}

// Function to fetch weather data from OpenMeteo
function fetchWeatherData(lat, lon, callback) {
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
      console.log("Raw data from OpenMeteo:", data); // Log the raw response data

      try {
        const jsonData = JSON.parse(data); // Parse the response JSON
        callback(null, jsonData); // Return data via callback
      } catch (error) {
        callback(error, null); // Handle JSON parse error
      }
    });
  });

  req.on("error", (e) => {
    console.error(`Problem with request: ${e.message}`);
    callback(e, null);
  });

  req.end(); // End the request
}

// HTTP server to handle requests
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/api/weather")) {
    const urlParams = new URL(req.url, `http://${req.headers.host}`);
    const lat = urlParams.searchParams.get("lat");
    const lon = urlParams.searchParams.get("lon");

    if (!lat || !lon) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Latitude and longitude are required" }));
      return;
    }

    // Fetch weather data from OpenMeteo
    fetchWeatherData(lat, lon, (error, weatherData) => {
      if (error) {
        console.error("Error fetching from OpenMeteo:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Error fetching weather data" }));
        return;
      }

      // Store data in MongoDB
      const weatherCollection = db.collection("weather");
      const weatherEntry = {
        lat: lat,
        lon: lon,
        data: weatherData,
        timestamp: new Date(),
      };

      weatherCollection.insertOne(weatherEntry, (err, result) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Error storing data in MongoDB" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(weatherData)); // Return the weather data
      });
    });
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

// Start the server
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
