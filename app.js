import { request, createServer } from "http";
import { MongoClient } from "mongodb";
import { guanajuatoCities, cityCoordinatesMap, getCityByName } from "./cities.js";

const config = {
  mongoUrl: process.env.MONGO_URL || "mongodb://mongodb:27017/weatherData",
  port: process.env.PORT || 3000,
  openMeteo: {
    current: "api.open-meteo.com",
    historical: "archive-api.open-meteo.com",
  },
};

const client = new MongoClient(config.mongoUrl);
let db;

async function connectDB() {
  await client.connect();
  db = client.db("weatherData");
  await db.collection("weather").createIndex({
    cityId: 1,
    "currentReadings.timestamp": -1,
  });
  return db;
}

function fetchWeather(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname, path, method: "GET" }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode !== 200)
            throw new Error(json.reason || "API Error");
          resolve(json);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.end();
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, DELETE, POST");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    if (req.url === "/health") {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ status: "OK" }));
      return;
    }

    if (req.url.startsWith("/api/weather")) {
      const params = new URL(req.url, `http://${req.headers.host}`)
        .searchParams;
      const coords = {
        latitude: parseFloat(params.get("lat")),
        longitude: parseFloat(params.get("lon")),
      };

      const coordKey = `${coords.latitude.toFixed(6)},${coords.longitude.toFixed(6)}`;
      const cityInfo = cityCoordinatesMap.get(coordKey);

      const weather = await fetchWeather(
        config.openMeteo.current,
        `/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}&current_weather=true&timezone=auto`,
      );

      if (cityInfo) {
        const timestamp = new Date();

        const currentReading = {
          timestamp,
          temperature: weather.current_weather.temperature,
          pressure: weather.current_weather.surface_pressure,
        };

        await db.collection("weather").updateOne(
          { cityId: cityInfo.id },
          {
            $setOnInsert: {
              cityName: cityInfo.name,
              lat: coords.latitude,
              lon: coords.longitude,
              historicalData: [],
            },
            $push: {
              currentReadings: {
                $each: [currentReading],
                $position: 0,
              },
            },
          },
          { upsert: true },
        );
      }

      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(weather));
      return;
    }

    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 5);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 7);
    
    const dateFormat = (date) => date.toISOString().split("T")[0];

    if (req.url === "/api/fetch-historical" && req.method === "POST") {      

      Promise.all(
        guanajuatoCities.map(async (city) => {
          try {
            const data = await fetchWeather(
              config.openMeteo.historical,
              `/v1/archive?latitude=${city.coord.lat}&longitude=${city.coord.lon}&start_date=${dateFormat(startDate)}&end_date=${dateFormat(endDate)}&hourly=temperature_2m,surface_pressure&timezone=auto`,
            );

            const historicalReadings = data.hourly.time.map(
              (timestamp, index) => ({
                timestamp: new Date(timestamp),
                temperature: data.hourly.temperature_2m[index],
                pressure: data.hourly.surface_pressure[index],
              }),
            );

            await db.collection("weather").updateOne(
              { cityId: city.id },
              {
                $setOnInsert: {
                  cityName: city.name,
                  lat: city.coord.lat,
                  lon: city.coord.lon,
                  currentReadings: [],
                },
                $push: {
                  historicalData: {
                    $each: historicalReadings,
                  },
                },
              },
              { upsert: true },
            );

            await new Promise((resolve) => setTimeout(resolve, 1000));
          } catch (error) {
            console.error(`Error fetching data for ${city.name}:`, error);
          }
        }),
      );
      res
        .writeHead(202)
        .end(JSON.stringify({ message: "Historical fetch started" }));
      return;
    }

    if (req.url.match(/^\/api\/historicaldata\/city\/([^/]+)$/)) {
      const cityName = decodeURIComponent(req.url.split("/").pop());
      let data = await db.collection("weather").findOne({ cityName });

      if (!data) { // if no data is found in the database
        const city = getCityByName(cityName);

        if (!city) { // if the city is not found
          res.writeHead(404).end(JSON.stringify({ error: "City not found" }));
          return;
        }
        try {
          data = await fetchWeather(
            config.openMeteo.historical,
            `/v1/archive?latitude=${city.coord.lat}&longitude=${city.coord.lon}&start_date=${dateFormat(startDate)}&end_date=${dateFormat(endDate)}&hourly=temperature_2m,surface_pressure&timezone=auto`,
          );

          const historicalReadings = data.hourly.time.map(
            (timestamp, index) => ({
              timestamp: new Date(timestamp),
              temperature: data.hourly.temperature_2m[index],
              pressure: data.hourly.surface_pressure[index],
            }),
          );

          await db.collection("weather").updateOne(
            { cityId: city.id },
            {
              $setOnInsert: {
                cityName: city.name,
                lat: city.coord.lat,
                lon: city.coord.lon,
                currentReadings: [],
              },
              $push: {
                historicalData: {
                  $each: historicalReadings,
                },
              },
            },
            { upsert: true },
          );

          res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ cityName, data }));
          return;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`Error fetching data for ${city.name}:`, error);
        } 
        
      }

      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(data));
      return;
    }

    if (req.url === "/api/historicaldata" && req.method === "DELETE") {
      const result = await db.collection("weather").deleteMany({});
      res.writeHead(200).end(JSON.stringify({ deleted: result.deletedCount }));
      return;
    }
      
        // Handle unknown routes
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Not found",
            availableEndpoints: {
              weather: "/api/weather?lat={latitude}&lon={longitude} (GET)",
              historical: "/api/fetch-historical (POST)",
              health: "/health",
              historicalDataByCity: "/api/historicaldata/city/{cityName} (PATCH)",
              deleteHistoricalData: "/api/historicaldata (DELETE)",
            },
          }),
        );



  } catch (error) {
    res
      .writeHead(error.message.includes("Invalid coordinates") ? 400 : 500, {
        "Content-Type": "application/json",
      })
      .end(JSON.stringify({ error: error.message }));
  }



});

process.on("SIGTERM", () => {
  server.close(async () => {
    await client.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
});

connectDB()
  .then(() => {
    server.listen(config.port, () =>
      console.log(`Server running on port ${config.port}`),
    );
  })
  .catch(console.error);
