import express from "express";
import { pool } from "./db.js";
import { sendMessage } from "./telegram.js";
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

function parseTasks(text) {
  const lines = text.split("\n");
  const tasks = [];

  for (const line of lines) {
    const match = line.match(/^(\d{2}:\d{2})\s+(.+)$/);
    if (!match) continue;

    tasks.push({
      time: match[1],
      name: match[2],
    });
  }

  return tasks;
}

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text.trim();

  // Try parsing tasks
  const tasks = parseTasks(text);

  if (tasks.length > 0) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const taskDate = tomorrow.toISOString().split("T")[0];

    for (const task of tasks) {
      await pool.query(
        `INSERT INTO tasks (chat_id, task_date, task_time, task_name)
         VALUES ($1, $2, $3, $4)`,
        [chatId, taskDate, task.time, task.name]
      );
    }

    await sendMessage(
      chatId,
      `✅ Saved ${tasks.length} tasks for ${taskDate}`
    );
  } else {
    await sendMessage(
      chatId,
      "❌ Format invalid.\nUse:\n07:00 Gym\n10:00 Study Go"
    );
  }

  res.sendStatus(200);
});

app.get("/", (_, res) => res.send("Bot is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running" , PORT));
