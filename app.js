import { request, createServer } from "http";
import { MongoClient } from "mongodb";
import { createClient } from "redis";
import { guanajuatoCities, cityCoordinatesMap, getCityByName } from "./cities.js";


const config = {
  mongoUrl: process.env.MONGO_URL || "mongodb://mongodb:27017/weatherData",
  redisUrl: process.env.REDIS_URL || "redis://redis:6379",
  port: process.env.PORT || 3000,
  openMeteo: {
    current: "api.open-meteo.com",
    historical: "archive-api.open-meteo.com",
  },
};

// Inicializamos el cliente de MongoDB

const client = new MongoClient(config.mongoUrl);

let db; 

async function connectDB() {
  await client.connect();
  db = client.db("weatherData");
  await db.collection("weather").createIndex({
    cityId: 1, // Indexamos por cityId
    "currentReadings.timestamp": -1, 
  });
  return db;
}

// Inicializamos el cliente de Redis

const redisClient = createClient({url: config.redisUrl}); 

async function connectRedis() {
    return new Promise((resolve, reject) => {
        redisClient.on("error", (err) => {
            console.error("Redis connection error", err);
            reject(err);
        });

        redisClient.on("connect", () => {
            console.log("Connected to Redis");
            resolve(redisClient);
        });

        redisClient.connect().catch(reject);
    });
}

await connectRedis();

// Constantes
const CACHE_LIMIT = 2;
const CITIES_LIST_KEY = 'cached_cities';

// Función para manejar el límite de ciudades en caché
async function manageCacheLimit(cityName) {
  try {
    // Añadir ciudad a la lista (o moverla al inicio si ya existe)
    await redisClient.lRem(CITIES_LIST_KEY, 0, cityName); // Eliminar la ciudad si ya existe
    await redisClient.lPush(CITIES_LIST_KEY, cityName); // Añadir la ciudad al inicio de la lista
    
    // Verificar si excedemos el límite
    const listLength = await redisClient.lLen(CITIES_LIST_KEY);
    // Impresión de las ciudades en caché
    const keys = await redisClient.lRange(CITIES_LIST_KEY, 0, -1);
    console.log('Cached cities:', keys);
    console.log('Cache length:', listLength);
    if (listLength == CACHE_LIMIT) {
      // Obtener y eliminar la ciudad más antigua
      const oldestCity = await redisClient.rPop(CITIES_LIST_KEY);
      await redisClient.lRem(CITIES_LIST_KEY,0 ,oldestCity); 
      await redisClient.del(oldestCity); 
    }
  } catch (error) {
    console.error('Error managing cache limit:', error);
  }
}

// Función para obtener datos de Redis
async function getFromRedis(key) {
  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('Redis get error:', error);
    return null;
  }
}

// Función helper para guardar datos en Redis
async function saveToRedis(cityName, data, ttl = 3600*24) {
  try {
    await manageCacheLimit(cityName);
    await redisClient.setEx(cityName, ttl, JSON.stringify(data)); //ttl tiene unidad en segundos
  } catch (error) {
    console.error('Redis save error:', error);
  }
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

// Creamos el servidor HTTP y las rutas de la API

const server = createServer(async (req, res) => {

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, DELETE, POST, PATCH");

    if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
    }

    // INIT Endpoint para obtener el status de la API

    if (req.url === "/health") {
        res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ status: "OK" }));
        return;
    } // END /health

    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 5);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 7);

    const dateFormat = (date) => date.toISOString().split("T")[0];

    // INIT Endpoint para obtener datos históricos de toda las ciudades de Guanajuato

    if (req.url === "/api/fetch-historical" && req.method === "POST") {      

        Promise.all( guanajuatoCities.map(async (city) => {
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
        ); // END Promise.all

        res.writeHead(202).end(JSON.stringify({ message: "Historical fetch started" }));
        // El res devuelve el mensaje hasta que 


        return;
    } // END /api/fetch-historical

    // INIT Endpoint para obtener datos históricos de una ciudad

    if (req.url.match(/^\/api\/historicaldata\/city\/([^/]+)$/) && req.method === "PATCH") {
        const cityName = decodeURIComponent(req.url.split("/").pop());

        // Check if data exists in Redis
        let data = await getFromRedis(cityName);

        if (data) {
            console.log(`Fetching historical data for ${cityName} from Redis`);
        } else {
            // If not found in Redis, check MongoDB
            data = await db.collection("weather").findOne({ cityName });

            if (data) {
                console.log(`Fetching historical data for ${cityName} from MongoDB`);
                // Save the data to Redis for future requests
                await saveToRedis(cityName, data);
            } else {
                // If no data is found in the database
                const city = getCityByName(cityName);

                if (!city) { // if the city is not found
                    res.writeHead(404).end(JSON.stringify({ error: "City not found" }));
                    return;
                }
            }
        }

        res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(data));
        return;
    } // END api/historicaldata/city/{cityName}

        
    // Handle unknown routes

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
        JSON.stringify({
        error: "Not found",
        availableEndpoints: {
            historical: "/api/fetch-historical (POST)",
            health: "/health",
            historicalDataByCity: "/api/historicaldata/city/{cityName} (PATCH)"
        },
        }),
    ); // END unknown routes

}); // END SERVER


// Cerramos la conexión a la base de datos y el servidor al recibir una señal de terminación
process.on("SIGTERM", () => {
  server.close(async () => { 
    await client.close(); // Cerramos la conexión a MongoDB
    await redisClient.quit(); // Cerramos la conexión a Redis
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
});

// Iniciamos el servidor de MongoDB y el servidor HTTP

connectDB().then(() => {
    server.listen(config.port, () => // Iniciamos el servidor HTTP
      console.log(`Server running on port ${config.port}`),
    );
  }).catch(console.error);

connectRedis().then(() => {
    console.log("Redis client initialized");
}).catch(console.error);
