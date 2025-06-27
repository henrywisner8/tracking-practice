const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const { Pool } = require('pg');
const fetch = require('node-fetch');
require('dotenv').config();

console.log("\u2705 Server starting...");
console.log("\u2705 ENV:", {
  OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
  DATABASE_URL: !!process.env.DATABASE_URL,
  UPS_CLIENT_ID: !!process.env.UPS_CLIENT_ID,
  UPS_CLIENT_SECRET: !!process.env.UPS_CLIENT_SECRET
});

const app = express();

app.use(cors({ origin: 'https://cerulean-jelly-b6b2ab.netlify.app' }));
app.use(express.json());
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function getUPSToken() {
  const res = await fetch('https://wwwcie.ups.com/security/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${process.env.UPS_CLIENT_ID}:${process.env.UPS_CLIENT_SECRET}`).toString('base64')
    },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to fetch UPS token');
  return data.access_token;
}

async function trackUPS(trackingNumber) {
  const token = await getUPSToken();
  const response = await fetch('https://wwwcie.ups.com/api/track/v1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'transId': 'ups-track-test',
      'transactionSrc': 'tracking-assistant',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ trackingNumber: [trackingNumber] })
  });

  const text = await response.text();
  try {
    const json = JSON.parse(text);
    if (!response.ok) {
      throw new Error(`UPS API error: ${response.status} - ${JSON.stringify(json)}`);
    }
    return json;
  } catch (err) {
    throw new Error(`UPS tracking failed: Could not parse JSON. Raw: ${text}`);
  }
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, threadId } = req.body;

    const match = message.match(/1Z[0-9A-Z]{16}/);
    if (match) {
      const trackingData = await trackUPS(match[0]);
      return res.json({
        response: `Here’s your UPS tracking info:\n\n${JSON.stringify(trackingData, null, 2)}`,
        threadId: threadId || 'N/A'
      });
    }

    let thread;
    if (threadId && threadId.startsWith('thread_')) {
      thread = await openai.beta.threads.retrieve(threadId);
    } else {
      thread = await openai.beta.threads.create();
    }

    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message
    });

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.OPENAI_ASSISTANT_ID
    });

    let runStatus;
    do {
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      await new Promise(r => setTimeout(r, 500));
    } while (runStatus.status !== 'completed');

    const messages = await openai.beta.threads.messages.list(thread.id);
    const reply = messages.data[0].content[0].text.value;

    await pool.query(
      'INSERT INTO chat_logs (thread_id, user_message, assistant_reply) VALUES ($1, $2, $3)',
      [thread.id, message, reply]
    );

    res.json({ response: reply, threadId: thread.id });
  } catch (err) {
    console.error('Error processing chat:', err);
    res.status(500).json({ error: 'Something went wrong: ' + err.message });
  }
});

app.get('/api/chat-logs/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing search query' });

  try {
    const result = await pool.query(
      `SELECT * FROM chat_logs WHERE user_message ILIKE $1 OR assistant_reply ILIKE $1 ORDER BY created_at DESC`,
      [`%${q}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Query failed' });
  }
});

app.get('/api/test-track/:number', async (req, res) => {
  try {
    const data = await trackUPS(req.params.number);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'UPS tracking failed: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

