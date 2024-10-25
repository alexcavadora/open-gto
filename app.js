import http from 'http';
import https from 'https';
import { MongoClient } from 'mongodb';

// MongoDB connection URL
const mongoUrl = 'mongodb://localhost:27017';
const dbName = 'weatherData';
const collectionName = 'archiveData';

// Open-Meteo API URL
const apiUrl = 'https://archive-api.open-meteo.com/v1/archive?latitude=20.5058&longitude=-101.53802&start_date=2019-09-15&end_date=2024-09-15&hourly=temperature_2m,surface_pressure&timezone=auto';

// Function to fetch data from Open-Meteo API
const fetchData = (callback) => {
    https.get(apiUrl, (res) => {
        let data = '';

        res.on('data', (chunk) => {
            data += chunk;
        });

        res.on('end', () => {
            callback(null, JSON.parse(data));
        });

    }).on('error', (err) => {
        callback(err);
    });
};

// Function to save data to MongoDB
const saveToDatabase = (data, callback) => {
    MongoClient.connect(mongoUrl, { useNewUrlParser: true, useUnifiedTopology: true }, (err, client) => {
        if (err) return callback(err);

        const db = client.db(dbName);
        const collection = db.collection(collectionName);

        collection.insertOne(data, (err, result) => {
            client.close();
            callback(err, result);
        });
    });
};

// Create HTTP server
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/fetch-and-save') {
        fetchData((err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error fetching data from API');
                return;
            }

            saveToDatabase(data, (err, result) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Error saving data to database');
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Data saved successfully', result }));
            });
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// Start the server
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});

console.log('App started');

