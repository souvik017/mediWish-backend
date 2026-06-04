const mysql = require("mysql2");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  idleTimeout: 60000,          // release idle connections after 60s
  // Retry strategy (built into mysql2)
  acquireTimeout: 60000,
  connectTimeout: 60000,
});

// Handle pool errors globally
pool.on('error', (err) => {
  console.error('Unexpected pool error', err);
  // Optionally attempt to reconnect or log to monitoring
});

module.exports = pool.promise();