const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const querystring = require('querystring');
const { parseStringPromise } = require('xml2js');

require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   🔐 CONFIG (REPLACE THESE)
========================= */
const BASE44_API_KEY = process.env.BASE44_API_KEY;
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* =========================
   🧠 OPENAI
========================= */
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* =========================
   🗄 DATABASE
========================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =========================
   📊 HALLUCINATION GUARD
========================= */
async function logToGuard(prompt, response) {
  try {
    await fetch(`https://api.base44.com/api/apps/${BASE44_APP_ID}/entities/EvalLog`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${BASE44_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt,
        response,
        model: "openai-assistant",
        endpoint: OPENAI_ASSISTANT_ID
      })
    });
  } catch (err) {
    console.error("⚠️ Logging failed:", err.message);
  }
}

/* =========================
   📦 UPS
========================= */
async function getUPSToken() {
  const res = await fetch('https://wwwcie.ups.com/security/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from("UPS_CLIENT_ID:UPS_CLIENT_SECRET").toString('base64')
    },
    body: 'grant_type=client_credentials'
  });

  const data = await res.json();
  return data.access_token;
}

async function trackUPS(trackingNumber) {
  const token = await getUPSToken();

  const response = await fetch('https://wwwcie.ups.com/api/track/v1/details', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ trackingNumber: [trackingNumber] })
  });

  return await response.json();
}

/* =========================
   📬 USPS
========================= */
async function trackUSPS(trackingNumber) {
  const xmlRequest = `
    <TrackFieldRequest USERID="YOUR_USPS_USER_ID">
      <TrackID ID="${trackingNumber}"></TrackID>
    </TrackFieldRequest>
  `.trim();

  const url = `https://secure.shippingapis.com/ShippingAPI.dll?API=TrackV2&XML=${encodeURIComponent(xmlRequest)}`;

  const res = await fetch(url);
  const xml = await res.text();

  const parsed = await parseStringPromise(xml);
  const info = parsed?.TrackResponse?.TrackInfo?.[0];

  return {
    summary: info?.TrackSummary?.[0] || "No summary",
    history: info?.TrackDetail || []
  };
}

/* =========================
   💬 CHAT ENDPOINT
========================= */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, threadId } = req.body;

    /* ===== UPS ===== */
    const matchUPS = message.match(/1Z[0-9A-Z]{16}/);
    if (matchUPS) {
      const data = await trackUPS(matchUPS[0]);

      const responseText = `UPS Tracking:\n${JSON.stringify(data, null, 2)}`;

      logToGuard(message, responseText);

      return res.json({
        response: responseText,
        threadId: threadId || 'N/A'
      });
    }

    /* ===== USPS ===== */
    const matchUSPS = message.match(/\b(94|92|93|95|96|97|98|420)[0-9]{16,34}\b/i);
    if (matchUSPS) {
      const { summary, history } = await trackUSPS(matchUSPS[0]);

      const responseText = `USPS Summary:\n${summary}\n\nHistory:\n${history.join('\n')}`;

      logToGuard(message, responseText);

      return res.json({
        response: responseText,
        threadId: threadId || 'N/A'
      });
    }

    /* ===== OPENAI ===== */
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
      assistant_id: OPENAI_ASSISTANT_ID
    });

    let status;
    do {
      status = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      await new Promise(r => setTimeout(r, 500));
    } while (status.status !== 'completed');

    const messages = await openai.beta.threads.messages.list(thread.id);
    const reply = messages.data[0].content[0].text.value.trim();

    /* 🔥 LOG TO GUARD */
    logToGuard(message, reply);

    /* 💾 SAVE TO DB */
    await pool.query(
      'INSERT INTO chat_logs (thread_id, user_message, assistant_reply) VALUES ($1, $2, $3)',
      [thread.id, message, reply]
    );

    return res.json({
      response: reply,
      threadId: thread.id
    });

  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   🚀 START SERVER
========================= */
const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Running on port ${PORT}`));
