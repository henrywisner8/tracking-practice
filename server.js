const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const querystring = require('querystring');
const { parseStringPromise } = require('xml2js');

require('dotenv').config();

console.log("✅ Server starting...");
console.log("✅ ENV:", {
  OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
  DATABASE_URL: !!process.env.DATABASE_URL,
  UPS_CLIENT_ID: !!process.env.UPS_CLIENT_ID,
  UPS_CLIENT_SECRET: !!process.env.UPS_CLIENT_SECRET,
  USPS_USER_ID: !!process.env.USPS_USER_ID
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


// UPS
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
  // 🧪 Mock tracking number support
  if (/^1ZCIETST/.test(trackingNumber)) {
    return {
      mock: true,
      status: "This is a test UPS tracking number. No real data is available.",
      trackingNumber
    };
  }

  const token = await getUPSToken();
  const response = await fetch('https://wwwcie.ups.com/api/track/v1/details', {
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

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`UPS tracking failed: Could not parse JSON. Raw: ${text.slice(0, 200)}`);
  }

  if (!response.ok || json?.errors || json?.response?.errors) {
    const message = json?.errors?.[0]?.message ||
                    json?.response?.errors?.[0]?.message ||
                    'Unknown UPS error';
    throw new Error(`UPS API error: ${response.status} - ${message}`);
  }

  return json;
}


// USPS
async function trackUSPS(trackingNumber) {
  const base = 'https://secure.shippingapis.com/ShippingAPI.dll';
  const xmlRequest = `
    <TrackFieldRequest USERID="${process.env.USPS_USER_ID}">
      <TrackID ID="${trackingNumber}"></TrackID>
    </TrackFieldRequest>
  `.trim();

  const qs = querystring.stringify({
    API: 'TrackV2',
    XML: xmlRequest
  });

  const url = `${base}?${qs}`;
  const res = await fetch(url);
  const xml = await res.text();

  if (!res.ok) {
    throw new Error(`USPS tracking failed (HTTP ${res.status}): ${xml}`);
  }

  let parsed;
  try {
    parsed = await parseStringPromise(xml, { explicitArray: true });
  } catch (e) {
    throw new Error(`Failed to parse USPS XML: ${e.message}\nRaw response:\n${xml}`);
  }

  const info = parsed?.TrackResponse?.TrackInfo?.[0];

  if (!info || info.Error) {
    const desc = info?.Error?.[0]?.Description || 'Unknown USPS error.';
    throw new Error(`No tracking info found. USPS Error: ${desc}`);
  }

  const summary = info.TrackSummary?.[0] || 'No summary available.';
  const history = info.TrackDetail || [];

  return {
    summary,
    history
  };
}


// Chat Endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, threadId } = req.body;

    const matchUPS = message.match(/1Z[0-9A-Z]{16}/);
    if (matchUPS) {
      console.log("🎯 Detected UPS tracking number:", matchUPS[0]);
      const trackingData = await trackUPS(matchUPS[0]);
      return res.json({
        response: `Here’s your UPS tracking info:\n\n${JSON.stringify(trackingData, null, 2)}`,
        threadId: threadId || 'N/A'
      });
    }

    const matchUSPS = message.match(/\b(94|92|93|94|95|96|97|98|420)[0-9]{16,34}\b/i);
    if (matchUSPS) {
      console.log("📦 Detected USPS tracking number:", matchUSPS[0]);
      const { summary, history } = await trackUSPS(matchUSPS[0]);
      return res.json({
        response: `📬 USPS Tracking Summary:\n${summary}\n\n📜 Tracking History:\n${history.join('\n')}`,
        threadId: threadId || 'N/A'
      });
    }

    // Default: OpenAI Assistant
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


// Search chat logs
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


// Manual UPS test
app.get('/api/test-track/:number', async (req, res) => {
  try {
    const data = await trackUPS(req.params.number);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'UPS tracking failed: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

setInterval(() => console.log("Still alive"), 10000);
