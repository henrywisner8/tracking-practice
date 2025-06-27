const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const { Pool } = require('pg');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();

// ✅ CORS: Allow only your Netlify frontend
app.use(cors({
  origin: 'https://cerulean-jelly-b6b2ab.netlify.app' // Update if your Netlify domain changes
}));

app.use(express.json());
app.use(express.static('public'));

// ✅ OpenAI setup
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ NeonDB setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ✅ UPS Auth helper
async function getUPSToken() {
  const response = await fetch('https://wwwcie.ups.com/security/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${process.env.UPS_CLIENT_ID}:${process.env.UPS_CLIENT_SECRET}`).toString('base64')
    },
    body: 'grant_type=client_credentials'
  });
  const data = await response.json();
  return data.access_token;
}

// ✅ UPS Tracking API call
async function trackUPS(trackingNumber) {
  const token = await getUPSToken();

  const response = await fetch('https://wwwcie.ups.com/api/track/v1/details', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      transId: 'tracking-example-1234',
      transactionSrc: 'tracking-app',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      locale: 'en_US',
      trackingNumber: [trackingNumber]  // ✅ Wrap in array
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`UPS API error: ${response.status} - ${text}`);
  }

  return await response.json();
}


// ✅ Chat Route w/ UPS integration + OpenAI + chat logging
app.post('/api/chat', async (req, res) => {
  try {
    const { message, threadId } = req.body;

    // Check for UPS tracking number pattern
    if (/1Z[0-9A-Z]{16}/.test(message)) {
      const trackingInfo = await trackUPS(message);
      return res.json({
        response: `Here’s your tracking info:\n\n${JSON.stringify(trackingInfo, null, 2)}`,
        threadId: threadId || 'N/A'
      });
    }

    // OpenAI thread flow
    const thread = threadId
      ? await openai.beta.threads.retrieve(threadId)
      : await openai.beta.threads.create();

    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message,
    });

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.OPENAI_ASSISTANT_ID,
    });

    let runStatus;
    do {
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      await new Promise(r => setTimeout(r, 500));
    } while (runStatus.status !== 'completed');

    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantReply = messages.data[0].content[0].text.value;

    // Log chat to DB
    await pool.query(
      'INSERT INTO chat_logs (thread_id, user_message, assistant_reply) VALUES ($1, $2, $3)',
      [thread.id, message, assistantReply]
    );

    res.json({
      response: assistantReply,
      threadId: thread.id,
    });
  } catch (err) {
    console.error('Error processing chat:', err);
    res.status(500).json({ error: 'Something went wrong processing your message.' });
  }
});

// ✅ Chat log search
app.get('/api/chat-logs/search', async (req, res) => {
  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'Missing search query' });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM chat_logs
       WHERE user_message ILIKE $1 OR assistant_reply ILIKE $1
       ORDER BY created_at DESC`,
      [`%${q}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error querying chat logs:', err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

// ✅ Test route to query UPS directly without chatbot
app.get('/api/track/:trackingNumber', async (req, res) => {
  const { trackingNumber } = req.params;

  try {
    const trackingInfo = await trackUPS(trackingNumber);
    res.json(trackingInfo);
  } catch (err) {
    console.error('Error fetching UPS tracking info:', err);
    res.status(500).json({ error: 'Failed to fetch UPS tracking data' });
  }
});


// ✅ Order lookup endpoint
app.get('/api/orders/:orderId', async (req, res) => {
  const { orderId } = req.params;
  try {
    const result = await pool.query('SELECT * FROM orders WHERE order_id = $1', [orderId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
