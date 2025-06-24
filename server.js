const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Route to handle chatbot interactions
app.post('/api/chat', async (req, res) => {
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

  res.json({
    response: messages.data[0].content[0].text.value,
    threadId: thread.id,
  });
});

// Mock Order Tracking Endpoint (Simple example)
app.get('/api/orders/:orderId', (req, res) => {
  const { orderId } = req.params;
  res.json({
    orderId,
    status: "In Transit",
    carrier: "UPS",
    trackingNumber: "1Z999999",
  });
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});
