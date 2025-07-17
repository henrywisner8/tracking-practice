const { ChatOpenAI } = require("langchain/chat_models/openai");
const { initializeAgentExecutorWithOptions } = require("langchain/agents");
const { DynamicTool } = require("langchain/tools");
const { Pool } = require("pg");

require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const getRecentChats = new DynamicTool({
  name: "get_recent_chats",
  description: "Get the 5 most recent chatbot conversations",
  func: async () => {
    const res = await pool.query(
      "SELECT user_message, assistant_reply, created_at FROM chat_logs ORDER BY created_at DESC LIMIT 5"
    );
    return JSON.stringify(res.rows, null, 2);
  }
});

const getChatCount = new DynamicTool({
  name: "get_chat_count",
  description: "Get the total number of chatbot messages logged",
  func: async () => {
    const res = await pool.query("SELECT COUNT(*) FROM chat_logs");
    return `Total chats: ${res.rows[0].count}`;
  }
});

const getLatestOrders = new DynamicTool({
  name: "get_latest_orders",
  description: "Fetch the 5 most recent orders",
  func: async () => {
    const res = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC LIMIT 5"
    );
    return JSON.stringify(res.rows, null, 2);
  }
});

const getAllChatsSummary = new DynamicTool({
  name: "get_all_chats_summary",
  description: "Summarize the first 100 chatbot interactions",
  func: async () => {
    const res = await pool.query(
      `SELECT user_message, assistant_reply, created_at 
       FROM chat_logs 
       ORDER BY created_at ASC 
       LIMIT 100`
    );

    if (!res.rows.length) return "No chats found.";

    const formatted = res.rows
      .map((row, i) =>
        `Chat #${i + 1} (${new Date(row.created_at).toLocaleString()}):\nUser: ${row.user_message}\nBot: ${row.assistant_reply}`
      )
      .join('\n\n');

    return `Here are the first 100 chatbot interactions:\n\n${formatted}`;
  }
});

async function createAnalyticsAgent() {
  const model = new ChatOpenAI({
    temperature: 0,
    openAIApiKey: process.env.OPENAI_API_KEY
  });

  const tools = [
    getRecentChats,
    getChatCount,
    getLatestOrders,
    getAllChatsSummary
  ];

  const agentExecutor = await initializeAgentExecutorWithOptions(tools, model, {
    agentType: "openai-functions",
    verbose: false
  });

  return agentExecutor;
}

module.exports = { createAnalyticsAgent };


