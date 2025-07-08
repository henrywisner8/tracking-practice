const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function testInsert() {
  console.log("🔌 Connecting to DB and writing log...");
  try {
    const threadId = "thread_test_123";
    const userMessage = "Where is my package?";
    const assistantReply = "Your package is on the way!";

    await pool.query(
      'INSERT INTO chat_logs (thread_id, user_message, assistant_reply) VALUES ($1, $2, $3)',
      [threadId, userMessage, assistantReply]
    );

    console.log("✅ Inserted test log successfully.");
  } catch (err) {
    console.error("❌ Error inserting log:", err.message);
  } finally {
    await pool.end();
  }
}

testInsert();
