const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// ✅ CORS: Allow your Netlify frontend
app.use(cors({
  origin: 'https://cerulean-jelly-b6b2ab.netlify.app'  // Update if your Netlify domain changes
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

// Route: Handle chatbot interaction + log chat
app.post('/api/chat', async (req, res) => {
  try {
    const { message, threadId } = req.body;

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

    // ✅ Save chat log
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

// Route: Retrieve order by ID
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


