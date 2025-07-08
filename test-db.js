const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    console.log("🧪 Connecting to database...");
    const res = await pool.query('SELECT NOW()');
    console.log("✅ DB Connected! Time:", res.rows[0].now);
    process.exit(0);
  } catch (err) {
    console.error("❌ DB Connection Failed:", err.message);
    process.exit(1);
  }
})();
