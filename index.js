import express from "express";
import { pool } from "./db.js";
import { sendMessage } from "./telegram.js";
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

const CRON_SECRET = process.env.CRON_SECRET;

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

async function getTasksForDate(userId, date) {
  const result = await pool.query(
    `SELECT id, task_time, task_name, status
     FROM tasks
     WHERE user_id = $1 AND task_date = $2
     ORDER BY task_time ASC`,
    [userId, date]
  );

  return result.rows;
}

const lastPlans = new Map();

function getTomorrowDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

function normalizeCommand(text) {
  return text.split("@")[0];
}

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id.toString();
  const rawText = message.text.trim();
  const text = normalizeCommand(rawText);

  /* =======================
     1️⃣ /plan
  ======================= */
  if (text === "/plan") {
    const userId = await getOrCreateUser(chatId);
    const taskDate = getTomorrowDate();

    const tasks = await getTasksForDate(userId, taskDate);

    if (tasks.length === 0) {
      await sendMessage(chatId, "📭 No tasks planned for tomorrow.");
      return res.sendStatus(200);
    }

    lastPlans.set(chatId, tasks);

    let reply = `📅 Plan for ${taskDate}\n\n`;
    tasks.forEach((t, i) => {
      reply += `${i + 1}. ${t.task_time.slice(0, 5)} — ${t.task_name}\n`;
    });

    await sendMessage(chatId, reply);
    return res.sendStatus(200);
  }

  /* =======================
     2️⃣ /edit
  ======================= */
  if (text === "/edit") {
    let plan = lastPlans.get(chatId);

    if (!plan || plan.length === 0) {
      const userId = await getOrCreateUser(chatId);
      const taskDate = getTomorrowDate();

      plan = await getTasksForDate(userId, taskDate);

      if (plan.length === 0) {
        await sendMessage(chatId, "❌ No tasks found. Use /plan first.");
        return res.sendStatus(200);
      }

      lastPlans.set(chatId, plan);
    }

    await sendMessage(
      chatId,
      "✏️ Reply like:\nedit <number> <new time> <new task>\n\nExample:\nedit 2 11:00 Study Go"
    );
    return res.sendStatus(200);
  }

  /* =======================
     3️⃣ edit <n> <time> <task>
  ======================= */
  if (text.startsWith("edit ")) {
    const parts = text.split(" ");
    if (parts.length < 4) {
      await sendMessage(chatId, "❌ Invalid edit format.");
      return res.sendStatus(200);
    }

    const index = parseInt(parts[1], 10) - 1;
    const time = parts[2];
    const name = parts.slice(3).join(" ");

    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
      await sendMessage(chatId, "❌ Invalid time format (HH:MM).");
      return res.sendStatus(200);
    }

    let plan = lastPlans.get(chatId);

    if (!plan || !plan[index]) {
      const userId = await getOrCreateUser(chatId);
      const taskDate = getTomorrowDate();

      plan = await getTasksForDate(userId, taskDate);
      lastPlans.set(chatId, plan);
    }

    if (!plan[index]) {
      await sendMessage(chatId, "❌ Invalid task number. Use /plan again.");
      return res.sendStatus(200);
    }

    const task = plan[index];

    await pool.query(
      `UPDATE tasks
       SET task_time = $1, task_name = $2
       WHERE id = $3`,
      [time, name, task.id]
    );

    // ✅ update cache
    task.task_time = time;
    task.task_name = name;

    await sendMessage(
      chatId,
      `✅ Task updated:\n${task.task_time.slice(0, 5)} ${task.task_name}`
    );

    return res.sendStatus(200);
  }

  // 3️⃣ /delete
if (text === "/delete") {
  let plan = lastPlans.get(chatId);

  if (!plan || plan.length === 0) {
    const userId = await getOrCreateUser(chatId);
    const taskDate = getTomorrowDate();

    plan = await getTasksForDate(userId, taskDate);

    if (plan.length === 0) {
      await sendMessage(chatId, "❌ No tasks to delete.");
      return res.sendStatus(200);
    }

    lastPlans.set(chatId, plan);
  }

  let reply = "🗑️ Select task to delete:\n\n";
  plan.forEach((t, i) => {
    reply += `${i + 1}. ${t.task_time.slice(0,5)} — ${t.task_name}\n`;
  });

  reply += "\nReply with:\ndelete <number>\n\nExample:\ndelete 2";

  await sendMessage(chatId, reply);
  return res.sendStatus(200);
}
// 4️⃣ delete <number>
if (text.startsWith("delete ")) {
  const parts = text.split(" ");
  const index = parseInt(parts[1], 10) - 1;

  if (isNaN(index)) {
    await sendMessage(chatId, "❌ Invalid delete format.\nUse: delete <number>");
    return res.sendStatus(200);
  }

  let plan = lastPlans.get(chatId);

  if (!plan || !plan[index]) {
    const userId = await getOrCreateUser(chatId);
    const taskDate = getTomorrowDate();

    plan = await getTasksForDate(userId, taskDate);
    lastPlans.set(chatId, plan);
  }

  if (!plan[index]) {
    await sendMessage(chatId, "❌ Invalid task number. Use /delete again.");
    return res.sendStatus(200);
  }

  const task = plan[index];

  await pool.query(
    "DELETE FROM tasks WHERE id = $1",
    [task.id]
  );

  // remove from cache
  plan.splice(index, 1);

  await sendMessage(
    chatId,
    `✅ Deleted: ${task.task_time.slice(0,5)} — ${task.task_name}`
  );

  return res.sendStatus(200);
}
if (text.startsWith("doing ")) {
  const response = text.replace("doing ", "").trim();

  const userId = await getOrCreateUser(chatId);
  const today = new Date().toISOString().split("T")[0];
  const nowTime = new Date().toTimeString().slice(0, 5);

  await pool.query(
    `
    UPDATE tasks
    SET user_response = $1,
        responded_at = NOW()
    WHERE user_id = $2
      AND task_date = $3
      AND task_time >= $4
    ORDER BY task_time ASC
    LIMIT 1
    `,
    [response, userId, today, nowTime]
  );

  await sendMessage(chatId, "✍️ Noted.");
  return res.sendStatus(200);
}

  /* =======================
     4️⃣ Ignore other commands
  ======================= */
  if (text.startsWith("/")) {
    return res.sendStatus(200);
  }

  /* =======================
     5️⃣ Parse & save tasks
  ======================= */
  const tasks = parseTasks(text);
  if (tasks.length === 0) {
    await sendMessage(
      chatId,
      "❌ Format invalid.\nUse:\n07:00 Gym\n10:00 Study Go"
    );
    return res.sendStatus(200);
  }

  const userId = await getOrCreateUser(chatId);
  const taskDate = getTomorrowDate();

  for (const task of tasks) {
    await pool.query(
      `INSERT INTO tasks (user_id, task_date, task_time, task_name)
       VALUES ($1, $2, $3, $4)`,
      [userId, taskDate, task.time, task.name]
    );
  }

  lastPlans.delete(chatId); // reset cache

  await sendMessage(
    chatId,
    `✅ Saved ${tasks.length} tasks for ${taskDate}`
  );

  res.sendStatus(200);
});

app.post("/cron/plan-reminder", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) {
    return res.sendStatus(401);
  }
  try {
    const result = await pool.query(
      "SELECT chat_id FROM users"
    );

    for (const row of result.rows) {
      await sendMessage(
        row.chat_id,
        "📌 Plan tomorrow’s tasks.\n\nReply like:\n07:00 Gym\n10:00 Study Go"
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Cron error:", err);
    res.status(500).json({ ok: false });
  }
});
app.post("/cron/morning-start", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) {
    return res.sendStatus(401);
  }

  try {
    const result = await pool.query(
      "SELECT chat_id FROM users"
    );

    for (const row of result.rows) {
      await sendMessage(
        row.chat_id,
        "🌅 Good morning.\n\nCheck today’s plan using /plan\nStay disciplined."
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Morning cron error:", err);
    res.status(500).json({ ok: false });
  }
});
app.post("/cron/task-reminders", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) {
    return res.sendStatus(401);
  }

  try {
    const now = new Date();

    // current time + 15 minutes
    const reminderTime = new Date(now.getTime() + 15 * 60 * 1000);

    const date = now.toISOString().split("T")[0];
    const time = reminderTime.toTimeString().slice(0, 5); // HH:MM

    const result = await pool.query(
      `
      SELECT t.id, t.task_time, t.task_name, u.chat_id
      FROM tasks t
      JOIN users u ON u.id = t.user_id
      WHERE t.task_date = $1
        AND t.task_time = $2
        AND t.reminder_sent = false
      `,
      [date, time]
    );

    for (const row of result.rows) {
      await sendMessage(
        row.chat_id,
        `⏰ Reminder\n\nAt ${row.task_time} you planned:\n${row.task_name}\n\nWhat are you doing right now?`
      );

      await pool.query(
        "UPDATE tasks SET reminder_sent = true WHERE id = $1",
        [row.id]
      );
    }

    res.json({ ok: true, checked: result.rowCount });
  } catch (err) {
    console.error("Task reminder error:", err);
    res.status(500).json({ ok: false });
  }
});
app.post("/cron/angry-check", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) {
    return res.sendStatus(401);
  }

  try {
    const now = new Date();
    const date = now.toISOString().split("T")[0];
    const time = now.toTimeString().slice(0, 5);

    const result = await pool.query(
      `
      SELECT t.task_name, t.user_response, u.chat_id
      FROM tasks t
      JOIN users u ON u.id = t.user_id
      WHERE t.task_date = $1
        AND t.task_time = $2
      `,
      [date, time]
    );

    for (const row of result.rows) {
      if (!row.user_response) {
        await sendMessage(
          row.chat_id,
          `😡 You planned "${row.task_name}" right now.\n\nNo response.\nStop wasting time and do the work.`
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Angry cron error:", err);
    res.status(500).json({ ok: false });
  }
});

app.get("/", (_, res) => res.send("Bot is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running" , PORT));
