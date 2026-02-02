import express from "express";
import { pool } from "./db.js";
import { sendMessage } from "./telegram.js";
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

async function getOrCreateUser(chatId) {
  const result = await pool.query(
    "SELECT id FROM users WHERE chat_id = $1",
    [chatId]
  );

  if (result.rows.length > 0) {
    return result.rows[0].id;
  }

  const insert = await pool.query(
    "INSERT INTO users (chat_id) VALUES ($1) RETURNING id",
    [chatId]
  );

  return insert.rows[0].id;
}

function parseTasks(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const tasks = [];

  for (const line of lines) {
    const match = line.match(/^([01]\d|2[0-3]):([0-5]\d)\s+(.+)$/);
    if (!match) continue;

    tasks.push({
  time: `${match[1]}:${match[2]}`,
  name: match[3],
});
  }

  return tasks;
}

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id.toString();
  const text = message.text.trim();

  const tasks = parseTasks(text);

  if (tasks.length === 0) {
    await sendMessage(
      chatId,
      "❌ Format invalid.\nUse:\n07:00 Gym\n10:00 Study Go"
    );
    return res.sendStatus(200);
  }

  const userId = await getOrCreateUser(chatId);

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const taskDate = tomorrow.toISOString().split("T")[0];

  for (const task of tasks) {
    await pool.query(
      `INSERT INTO tasks (user_id, task_date, task_time, task_name)
       VALUES ($1, $2, $3, $4)`,
      [userId, taskDate, task.time, task.name]
    );
  }

  await sendMessage(
    chatId,
    `✅ Saved ${tasks.length} tasks for ${taskDate}`
  );

  res.sendStatus(200);
});


app.get("/", (_, res) => res.send("Bot is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running" , PORT));
