// routes/analyticsBot.js
require('dotenv').config();
const express = require('express');
const router = express.Router();
const { OpenAI } = require('openai');
const { Pool } = require('pg');
const ASSISTANT_ID = process.env.OPENAI_ANALYTICS_ASSISTANT_ID;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ASSISTANT_ID = 'asst_n8H7Hht2vthmLigo2JSS1dWf';

// Define tool functions
const tools = {
  get_chat_count: async () => {
    const res = await pool.query('SELECT COUNT(*) FROM chat_logs');
    return `Total chats: ${res.rows[0].count}`;
  },
  get_recent_chats: async () => {
    const res = await pool.query(
      `SELECT user_message, assistant_reply, created_at 
       FROM chat_logs ORDER BY created_at DESC LIMIT 5`
    );
    return JSON.stringify(res.rows, null, 2);
  },
  get_all_chats_summary: async () => {
    const res = await pool.query(
      `SELECT user_message, assistant_reply, created_at 
       FROM chat_logs ORDER BY created_at ASC LIMIT 100`
    );
    if (!res.rows.length) return "No chats found.";
    const summary = res.rows
      .map((row, i) =>
        `Chat #${i + 1} (${new Date(row.created_at).toLocaleString()}):\nUser: ${row.user_message}\nBot: ${row.assistant_reply}`
      )
      .join('\n\n');
    return summary;
  }
};

// Route to handle assistant message
router.post('/', async (req, res) => {
  try {
    const { message } = req.body;

    // Create a thread
    const thread = await openai.beta.threads.create();

    // Add the user's message
    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: message
    });

    // Run the assistant
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: ASSISTANT_ID
    });

    // Poll until done
    let runStatus;
    do {
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      if (runStatus.status !== 'completed') {
        await new Promise(r => setTimeout(r, 1000));
      }
    } while (runStatus.status !== 'completed');

    // Check if tool call needed
    const messages = await openai.beta.threads.messages.list(thread.id);
    const toolCalls = runStatus.required_action?.submit_tool_outputs?.tool_calls;

    if (toolCalls) {
  const outputs = await Promise.all(
    toolCalls.map(async call => {
      console.log(`🔧 Tool called: ${call.function.name}`, call.function.arguments);

      return {
        tool_call_id: call.id,
        output: tools[call.function.name]
          ? await tools[call.function.name](JSON.parse(call.function.arguments))
          : `Tool "${call.function.name}" is not implemented.`
      };
    })
  );

  await openai.beta.threads.runs.submitToolOutputs(thread.id, run.id, {
    tool_outputs: outputs
  });

  // Wait again for final message
  let finalStatus;
  do {
    finalStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    if (finalStatus.status !== 'completed') {
      await new Promise(r => setTimeout(r, 1000));
    }
  } while (finalStatus.status !== 'completed');
}


    const finalMessages = await openai.beta.threads.messages.list(thread.id);
    const finalResponse = finalMessages.data.find(msg => msg.role === 'assistant');
    res.json({ response: finalResponse?.content[0]?.text?.value || 'No response.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Assistant failed to respond.' });
  }
});

module.exports = router;
