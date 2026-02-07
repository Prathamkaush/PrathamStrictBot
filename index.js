import express from "express";
import { pool } from "./db.js";
import { sendMessage } from "./telegram.js";
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

const CRON_SECRET = process.env.CRON_SECRET;

//--------------
//Middleware 
//--------------
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

function isSuccessfulDay(planned, completed) {
  if (planned === 0) return false;
  return completed / planned >= 0.7;
}

//--------------
//All logic stays here
//--------------
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

//--------------
//Plan reminder at 10 pm 
//--------------
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

//--------------
//task reminder cron job every 5 min
//--------------

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

//--------------
//Behaviuor check
//--------------
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
      SELECT t.id, t.task_name, t.user_response, t.praised, u.chat_id
      FROM tasks t
      JOIN users u ON u.id = t.user_id
      WHERE t.task_date = $1
        AND t.task_time = $2
        AND t.praised = false
      `,
      [date, time]
    );

    for (const row of result.rows) {
      const response = (row.user_response || "").toLowerCase();
      const taskWords = row.task_name.toLowerCase().split(" ");

      const isDoingTask = taskWords.some(word =>
        response.includes(word)
      );

      if (row.user_response && isDoingTask) {
        // 😌 PRAISE
        await sendMessage(
          row.chat_id,
          `😌 Good.\n\nYou planned "${row.task_name}" and you’re doing it.\nKeep going.`
        );

        await pool.query(
          "UPDATE tasks SET praised = true WHERE id = $1",
          [row.id]
        );
      } else {
        // 😡 ANGRY
        await sendMessage(
          row.chat_id,
          `😡 You planned "${row.task_name}" right now.\n\nDiscipline means doing what you said you would.\nFix it.`
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Discipline cron error:", err);
    res.status(500).json({ ok: false });
  }
});

//--------------
//daily summery
//--------------
app.post("/cron/daily-summary", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) {
    return res.sendStatus(401);
  }

  try {
    const today = new Date().toISOString().split("T")[0];

    const result = await pool.query(`
      SELECT
        u.chat_id,
        COUNT(t.id) AS planned,
        COUNT(*) FILTER (WHERE t.praised = true) AS completed,
        COUNT(*) FILTER (WHERE t.praised = false) AS missed,
        ARRAY_AGG(t.task_name) FILTER (WHERE t.praised = false) AS missed_tasks
      FROM tasks t
      JOIN users u ON u.id = t.user_id
      WHERE t.task_date = $1
      GROUP BY u.chat_id
    `, [today]);

    for (const row of result.rows) {
  const planned = Number(row.planned);
  const completed = Number(row.completed);
  const missed = planned - completed;

  const success = isSuccessfulDay(planned, completed);

  // get user_id
  const userResult = await pool.query(
    "SELECT id FROM users WHERE chat_id = $1",
    [row.chat_id]
  );
  const userId = userResult.rows[0].id;

  // fetch streak
  const statsResult = await pool.query(
    "SELECT current_streak, longest_streak, last_success_date FROM user_stats WHERE user_id = $1",
    [userId]
  );

  let currentStreak = 0;
  let longestStreak = 0;
  let lastDate = null;

  if (statsResult.rows.length > 0) {
    ({ current_streak: currentStreak, longest_streak: longestStreak, last_success_date: lastDate } = statsResult.rows[0]);
  }

  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

  if (success) {
    if (lastDate === yesterday) {
      currentStreak += 1;
    } else {
      currentStreak = 1;
    }

    longestStreak = Math.max(longestStreak, currentStreak);

    await pool.query(
      `
      INSERT INTO user_stats (user_id, current_streak, longest_streak, last_success_date)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id)
      DO UPDATE SET
        current_streak = $2,
        longest_streak = $3,
        last_success_date = $4
      `,
      [userId, currentStreak, longestStreak, today]
    );
  } else {
    await pool.query(
      `
      UPDATE user_stats
      SET current_streak = 0
      WHERE user_id = $1
      `,
      [userId]
    );
  }

  // 🧾 summary message
  let message =
`📊 Daily Summary

Planned: ${planned}
Completed: ${completed}
Missed: ${missed}`;

  if (success) {
    message += `

🔥 Streak: ${currentStreak} day(s)
Keep it alive.`;
  } else {
    message += `

❌ Streak broken.
Discipline resets tomorrow.`;
  }

  await sendMessage(row.chat_id, message);
}


    res.json({ ok: true });
  } catch (err) {
    console.error("Daily summary error:", err);
    res.status(500).json({ ok: false });
  }
});

//--------------
//daily reset at 11 pm 
//--------------
app.post("/cron/daily-reset", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) {
    return res.sendStatus(401);
  }

  try {
    await pool.query(`
      UPDATE tasks
      SET
        reminder_sent = false,
        praised = false,
        scolded = false,
        user_response = NULL,
        responded_at = NULL
      WHERE task_date < CURRENT_DATE
    `);

    res.json({ ok: true });
  } catch (err) {
    console.error("Daily reset error:", err);
    res.status(500).json({ ok: false });
  }
});

app.get("/", (_, res) => res.send("Bot is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running" , PORT));
