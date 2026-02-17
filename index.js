import express from "express";
import { pool } from "./db.js";
import { sendMessage } from "./telegram.js";
import { 
  praiseMessage, 
  angryMessage, 
  summaryMessage, 
  stuckHelp,
  morningMessage,
  planningPrompt 
} from "./ai.js";
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

const CRON_SECRET = process.env.CRON_SECRET;

// AI usage limits (per user per day)
const AI_DAILY_LIMIT = 20;

//--------------
// Timezone & Date Helpers
//--------------
function getUserDate(timezoneOffset = 0) {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const userTime = new Date(utc + (timezoneOffset * 60000));
  return userTime.toISOString().split("T")[0];
}

function getUserTime(timezoneOffset = 0) {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const userTime = new Date(utc + (timezoneOffset * 60000));
  return userTime.toTimeString().slice(0, 5); // HH:MM
}

// Returns total minutes since midnight in user's timezone
function getUserMinutes(timezoneOffset = 0) {
  const t = getUserTime(timezoneOffset);
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function getTodayDate() {
  return new Date().toISOString().split("T")[0];
}

function getDatePlusDays(baseDate, days) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function getUserTomorrowDate(timezoneOffset = 0) {
  // Tomorrow relative to the USER's current date, not server date
  const userDate = getUserDate(timezoneOffset);
  return getDatePlusDays(userDate, 1);
}

//--------------
// Helpers
//--------------
async function getOrCreateUser(chatId) {
  const result = await pool.query(
    "SELECT id, timezone_offset FROM users WHERE chat_id = $1",
    [chatId]
  );
  if (result.rows.length > 0) return result.rows[0];

  const insert = await pool.query(
    "INSERT INTO users (chat_id, timezone_offset) VALUES ($1, 0) RETURNING id, timezone_offset",
    [chatId]
  );
  return insert.rows[0];
}

function parseTasks(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const tasks = [];
  for (const line of lines) {
    const match = line.match(/^([01]\d|2[0-3]):([0-5]\d)\s+(.+)$/);
    if (!match) continue;
    tasks.push({ time: `${match[1]}:${match[2]}`, name: match[3] });
  }
  return tasks;
}

async function getTasksForDate(userId, date) {
  const result = await pool.query(
    `SELECT id, task_time, task_name
     FROM tasks
     WHERE user_id = $1 AND task_date = $2
     ORDER BY task_time ASC`,
    [userId, date]
  );
  return result.rows;
}

// Returns which date to show/save based on user's current hour
// After 6 PM: use tomorrow (planning ahead)
// Before 6 PM: use today
function getActiveDate(timezoneOffset = 0) {
  const userMinutes = getUserMinutes(timezoneOffset);
  const userDate = getUserDate(timezoneOffset);
  if (userMinutes >= 18 * 60) {
    return { date: getUserTomorrowDate(timezoneOffset), label: "tomorrow" };
  }
  return { date: userDate, label: "today" };
}

const lastPlans = new Map(); // chatId -> { date, tasks }

function normalizeCommand(text) {
  return text.split("@")[0];
}

function isSuccessfulDay(planned, completed) {
  if (planned === 0) return false;
  return completed / planned >= 0.7;
}

async function checkStuckRateLimit(userId) {
  const today = getTodayDate();
  const result = await pool.query(
    `SELECT stuck_count, stuck_reset_date FROM users WHERE id = $1`,
    [userId]
  );
  const { stuck_count, stuck_reset_date } = result.rows[0];

  if (stuck_reset_date !== today) {
    await pool.query(
      `UPDATE users SET stuck_count = 1, stuck_reset_date = $1 WHERE id = $2`,
      [today, userId]
    );
    return true;
  }
  if (stuck_count >= 5) return false;
  await pool.query(
    `UPDATE users SET stuck_count = stuck_count + 1 WHERE id = $1`,
    [userId]
  );
  return true;
}

// Atomic: reserve quota or reject. Returns true if quota was available.
async function reserveAIQuota(userId) {
  const today = getTodayDate();
  const result = await pool.query(
    `
    UPDATE users
    SET 
      ai_calls_today = CASE 
        WHEN ai_reset_date IS DISTINCT FROM $1 THEN 1
        ELSE ai_calls_today + 1
      END,
      ai_reset_date = $1
    WHERE id = $2
      AND (ai_reset_date IS DISTINCT FROM $1 OR ai_calls_today < $3)
    RETURNING ai_calls_today
    `,
    [today, userId, AI_DAILY_LIMIT]
  );
  return result.rowCount > 0;
}

// Rollback one AI call if OpenAI failed after quota was reserved
async function rollbackAIQuota(userId) {
  await pool.query(
    `UPDATE users SET ai_calls_today = GREATEST(0, ai_calls_today - 1) WHERE id = $1`,
    [userId]
  );
}

//--------------
// Webhook - all user interactions
//--------------
app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id.toString();
  const rawText = message.text.trim();
  const text = normalizeCommand(rawText);

  /* /stuck */
  if (text.startsWith("/stuck")) {
    const problem = text.replace("/stuck", "").trim();
    if (!problem) {
      await sendMessage(chatId, "❓ Tell me what you're stuck with.\n\nExample:\n/stuck can't focus on work");
      return res.sendStatus(200);
    }
    const user = await getOrCreateUser(chatId);
    if (!(await checkStuckRateLimit(user.id))) {
      await sendMessage(chatId, "⏱️ Too many requests. Try again tomorrow.");
      return res.sendStatus(200);
    }
    if (!(await reserveAIQuota(user.id))) {
      await sendMessage(chatId, "🚫 Daily AI limit reached. Try again tomorrow.");
      return res.sendStatus(200);
    }
    try {
      const aiResponse = await stuckHelp(problem);
      await sendMessage(chatId, aiResponse);
    } catch (err) {
      console.error("AI stuck error:", err);
      await rollbackAIQuota(user.id);
      await sendMessage(chatId, "❌ AI temporarily unavailable. Try again later.");
    }
    return res.sendStatus(200);
  }

  /* /timezone */
  if (text.startsWith("/timezone")) {
    const offsetStr = text.replace("/timezone", "").trim();
    const offset = parseInt(offsetStr, 10);
    if (!offsetStr || isNaN(offset) || offset < -720 || offset > 840) {
      await sendMessage(chatId,
        "❌ Invalid timezone offset.\n\nUse minutes from UTC:\n" +
        "/timezone 330   → IST (UTC+5:30)\n" +
        "/timezone 0     → UTC\n" +
        "/timezone -300  → EST (UTC-5)\n" +
        "/timezone 480   → CST China (UTC+8)"
      );
      return res.sendStatus(200);
    }
    const user = await getOrCreateUser(chatId);
    await pool.query(`UPDATE users SET timezone_offset = $1 WHERE id = $2`, [offset, user.id]);
    const sign = offset >= 0 ? '+' : '-';
    const absOffset = Math.abs(offset);
    const hours = Math.floor(absOffset / 60);
    const mins = absOffset % 60;
    const display = mins === 0 ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${String(mins).padStart(2,'0')}`;
    await sendMessage(chatId, `✅ Timezone set to ${display}\n\nYour current time: ${getUserTime(offset)}`);
    return res.sendStatus(200);
  }

  /* /plan */
  if (text === "/plan") {
    const user = await getOrCreateUser(chatId);
    const { date: taskDate, label } = getActiveDate(user.timezone_offset);
    const tasks = await getTasksForDate(user.id, taskDate);

    if (tasks.length === 0) {
      await sendMessage(chatId, `📭 No tasks planned for ${label}.`);
      return res.sendStatus(200);
    }

    lastPlans.set(chatId, { date: taskDate, tasks });
    const dateLabel = label.charAt(0).toUpperCase() + label.slice(1);
    let reply = `📅 ${dateLabel}'s Plan (${taskDate})\n\n`;
    tasks.forEach((t, i) => {
      reply += `${i + 1}. ${t.task_time.slice(0, 5)} — ${t.task_name}\n`;
    });
    await sendMessage(chatId, reply);
    return res.sendStatus(200);
  }

  /* /edit */
  if (text === "/edit") {
    const user = await getOrCreateUser(chatId);
    const { date: taskDate } = getActiveDate(user.timezone_offset);
    let cached = lastPlans.get(chatId);
    let plan = (cached && cached.date === taskDate) ? cached.tasks : null;

    if (!plan || plan.length === 0) {
      plan = await getTasksForDate(user.id, taskDate);
      if (plan.length === 0) {
        await sendMessage(chatId, "❌ No tasks found. Use /plan first.");
        return res.sendStatus(200);
      }
      lastPlans.set(chatId, { date: taskDate, tasks: plan });
    }
    await sendMessage(chatId,
      "✏️ Reply like:\nedit <number> <new time> <new task>\n\nExample:\nedit 2 11:00 Study Go"
    );
    return res.sendStatus(200);
  }

  /* edit <n> <time> <task> */
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
    const user = await getOrCreateUser(chatId);
    const { date: taskDate } = getActiveDate(user.timezone_offset);
    let cached = lastPlans.get(chatId);
    let plan = (cached && cached.date === taskDate) ? cached.tasks : null;

    if (!plan || !plan[index]) {
      plan = await getTasksForDate(user.id, taskDate);
      lastPlans.set(chatId, { date: taskDate, tasks: plan });
    }
    if (!plan[index]) {
      await sendMessage(chatId, "❌ Invalid task number. Use /plan again.");
      return res.sendStatus(200);
    }
    const task = plan[index];
    await pool.query(
      `UPDATE tasks SET task_time = $1, task_name = $2 WHERE id = $3`,
      [time, name, task.id]
    );
    task.task_time = time;
    task.task_name = name;
    await sendMessage(chatId, `✅ Task updated:\n${time} — ${name}`);
    return res.sendStatus(200);
  }

  /* /delete */
  if (text === "/delete") {
    const user = await getOrCreateUser(chatId);
    const { date: taskDate } = getActiveDate(user.timezone_offset);
    let cached = lastPlans.get(chatId);
    let plan = (cached && cached.date === taskDate) ? cached.tasks : null;

    if (!plan || plan.length === 0) {
      plan = await getTasksForDate(user.id, taskDate);
      if (plan.length === 0) {
        await sendMessage(chatId, "❌ No tasks to delete.");
        return res.sendStatus(200);
      }
      lastPlans.set(chatId, { date: taskDate, tasks: plan });
    }
    let reply = "🗑️ Select task to delete:\n\n";
    plan.forEach((t, i) => {
      reply += `${i + 1}. ${t.task_time.slice(0,5)} — ${t.task_name}\n`;
    });
    reply += "\nReply with:\ndelete <number>\n\nExample:\ndelete 2";
    await sendMessage(chatId, reply);
    return res.sendStatus(200);
  }

  /* delete <number> */
  if (text.startsWith("delete ")) {
    const parts = text.split(" ");
    const index = parseInt(parts[1], 10) - 1;
    if (isNaN(index)) {
      await sendMessage(chatId, "❌ Invalid delete format.\nUse: delete <number>");
      return res.sendStatus(200);
    }
    const user = await getOrCreateUser(chatId);
    const { date: taskDate } = getActiveDate(user.timezone_offset);
    let cached = lastPlans.get(chatId);
    let plan = (cached && cached.date === taskDate) ? cached.tasks : null;

    if (!plan || !plan[index]) {
      plan = await getTasksForDate(user.id, taskDate);
      lastPlans.set(chatId, { date: taskDate, tasks: plan });
    }
    if (!plan[index]) {
      await sendMessage(chatId, "❌ Invalid task number. Use /delete again.");
      return res.sendStatus(200);
    }
    const task = plan[index];
    await pool.query("DELETE FROM tasks WHERE id = $1", [task.id]);
    plan.splice(index, 1);
    await sendMessage(chatId, `✅ Deleted: ${task.task_time.slice(0,5)} — ${task.task_name}`);
    return res.sendStatus(200);
  }

  /* doing <response> */
  if (text.startsWith("doing ")) {
    const response = text.replace("doing ", "").trim();
    const user = await getOrCreateUser(chatId);
    const userDate = getUserDate(user.timezone_offset);
    const nowTime = getUserTime(user.timezone_offset);

    const result = await pool.query(
      `
      UPDATE tasks
      SET user_response = $1, responded_at = NOW()
      WHERE user_id = $2
        AND task_date = $3
        AND task_time <= $4
        AND user_response IS NULL
      ORDER BY task_time DESC
      LIMIT 1
      RETURNING id
      `,
      [response, user.id, userDate, nowTime]
    );
    if (result.rowCount === 0) {
      await sendMessage(chatId, "⚠️ No matching task found for this time.");
    } else {
      await sendMessage(chatId, "✍️ Noted.");
    }
    return res.sendStatus(200);
  }

  /* Ignore unknown commands */
  if (text.startsWith("/")) return res.sendStatus(200);

  /* Save tasks */
  const tasks = parseTasks(text);
  if (tasks.length === 0) {
    await sendMessage(chatId, "❌ Format invalid.\nUse:\n07:00 Gym\n10:00 Study Go");
    return res.sendStatus(200);
  }
  const user = await getOrCreateUser(chatId);
  const { date: taskDate, label: dateLabel } = getActiveDate(user.timezone_offset);

  for (const task of tasks) {
    await pool.query(
      `INSERT INTO tasks (user_id, task_date, task_time, task_name) VALUES ($1, $2, $3, $4)`,
      [user.id, taskDate, task.time, task.name]
    );
  }
  lastPlans.delete(chatId);
  await sendMessage(chatId, `✅ Saved ${tasks.length} tasks for ${dateLabel} (${taskDate})`);
  res.sendStatus(200);
});

//--------------
// CRON: Plan reminder (~10 PM user time)
// FIXED: Use minute range check instead of === hour, add sent-today guard
//--------------
app.post("/cron/plan-reminder", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) return res.sendStatus(401);

  try {
    const users = await pool.query("SELECT id, chat_id, timezone_offset FROM users");

    for (const row of users.rows) {
      try {
        const userMinutes = getUserMinutes(row.timezone_offset);
        const userDate = getUserDate(row.timezone_offset);

        // FIXED: Trigger between 22:00–22:09 (9-min window, safe for hourly cron)
        if (userMinutes < 22 * 60 || userMinutes > 22 * 60 + 9) continue;

        // FIXED: Guard against double-send — check if already sent today
        const check = await pool.query(
          `SELECT 1 FROM user_events 
           WHERE user_id = $1 AND event_type = 'plan_reminder' AND event_date = $2`,
          [row.id, userDate]
        );
        if (check.rowCount > 0) continue;

        // Record that we sent it
        await pool.query(
          `INSERT INTO user_events (user_id, event_type, event_date) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [row.id, 'plan_reminder', userDate]
        );

        if (!(await reserveAIQuota(row.id))) {
          await sendMessage(row.chat_id, "📌 Time to plan tomorrow!\n\nReply like:\n07:00 Gym\n10:00 Study Go");
          continue;
        }

        try {
          const aiPrompt = await planningPrompt();
          await sendMessage(row.chat_id, `${aiPrompt}\n\nReply like:\n07:00 Gym\n10:00 Study Go`);
        } catch (err) {
          await rollbackAIQuota(row.id);
          await sendMessage(row.chat_id, "📌 Time to plan tomorrow!\n\nReply like:\n07:00 Gym\n10:00 Study Go");
        }
      } catch (err) {
        console.error(`Plan reminder error for user ${row.id}:`, err);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Plan reminder cron error:", err);
    res.status(500).json({ ok: false });
  }
});

//--------------
// CRON: Morning message (~7 AM user time)
// FIXED: Use minute range check, add sent-today guard
//--------------
app.post("/cron/morning-start", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) return res.sendStatus(401);

  try {
    const users = await pool.query("SELECT id, chat_id, timezone_offset FROM users");

    for (const row of users.rows) {
      try {
        const userMinutes = getUserMinutes(row.timezone_offset);
        const userDate = getUserDate(row.timezone_offset);

        // FIXED: Trigger between 07:00–07:09 (9-min window)
        if (userMinutes < 7 * 60 || userMinutes > 7 * 60 + 9) continue;

        // FIXED: Guard against double-send
        const check = await pool.query(
          `SELECT 1 FROM user_events 
           WHERE user_id = $1 AND event_type = 'morning_start' AND event_date = $2`,
          [row.id, userDate]
        );
        if (check.rowCount > 0) continue;

        await pool.query(
          `INSERT INTO user_events (user_id, event_type, event_date) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [row.id, 'morning_start', userDate]
        );

        const tasks = await getTasksForDate(row.id, userDate);

        if (!(await reserveAIQuota(row.id))) {
          await sendMessage(row.chat_id, `🌅 Good morning!\n\nYou have ${tasks.length} tasks today. Use /plan to see them.`);
          continue;
        }

        try {
          const aiMessage = await morningMessage(tasks.length);
          await sendMessage(row.chat_id, `${aiMessage}\n\nUse /plan to see today's tasks.`);
        } catch (err) {
          await rollbackAIQuota(row.id);
          await sendMessage(row.chat_id, `🌅 Good morning!\n\nYou have ${tasks.length} tasks today. Use /plan to see them.`);
        }
      } catch (err) {
        console.error(`Morning error for user ${row.id}:`, err);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Morning cron error:", err);
    res.status(500).json({ ok: false });
  }
});

//--------------
// CRON: Task reminders (every 5 min)
// FIXED: ±7 min window to survive cron drift, atomic update prevents double-fire
//--------------
app.post("/cron/task-reminders", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) return res.sendStatus(401);

  try {
    const users = await pool.query("SELECT id, chat_id, timezone_offset FROM users");

    for (const user of users.rows) {
      try {
        const userDate = getUserDate(user.timezone_offset);
        const userMinutes = getUserMinutes(user.timezone_offset);

        // Target: tasks starting in 8–22 minutes from now
        // FIXED: Window of 14 min = cron runs every 5 min, so every task gets caught in ≥1 run
        const windowStart = userMinutes + 8;
        const windowEnd   = userMinutes + 22;

        // FIXED: Atomic update with FOR UPDATE SKIP LOCKED prevents double-fire
        const result = await pool.query(
          `
          UPDATE tasks
          SET reminder_sent = true
          WHERE id IN (
            SELECT id FROM tasks
            WHERE user_id = $1
              AND task_date = $2
              AND reminder_sent = false
              AND (
                EXTRACT(HOUR FROM task_time::time) * 60 +
                EXTRACT(MINUTE FROM task_time::time)
              ) BETWEEN $3 AND $4
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id, task_time, task_name
          `,
          [user.id, userDate, windowStart, windowEnd]
        );

        for (const task of result.rows) {
          await sendMessage(
            user.chat_id,
            `⏰ Reminder\n\nAt ${task.task_time.slice(0,5)} you planned:\n${task.task_name}\n\nWhat are you doing right now?\n\nReply: doing <your answer>`
          );
        }
      } catch (err) {
        console.error(`Reminder error for user ${user.id}:`, err);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Task reminder cron error:", err);
    res.status(500).json({ ok: false });
  }
});

//--------------
// CRON: Angry/Praise check (every 5 min)
// FIXED: ±7 min window instead of exact time match
//--------------
app.post("/cron/angry-check", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) return res.sendStatus(401);

  try {
    const users = await pool.query("SELECT id, chat_id, timezone_offset FROM users");

    for (const user of users.rows) {
      try {
        const userDate = getUserDate(user.timezone_offset);
        const userMinutes = getUserMinutes(user.timezone_offset);

        // Check tasks whose time is within ±7 minutes of now
        // (These are tasks that just had their reminder fire)
        const windowStart = userMinutes - 7;
        const windowEnd   = userMinutes + 7;

        const result = await pool.query(
          `
          SELECT t.id, t.task_name, t.user_response
          FROM tasks t
          WHERE t.user_id = $1
            AND t.task_date = $2
            AND t.praised = false
            AND t.scolded = false
            AND t.reminder_sent = true
            AND (
              EXTRACT(HOUR FROM task_time::time) * 60 +
              EXTRACT(MINUTE FROM task_time::time)
            ) BETWEEN $3 AND $4
          `,
          [user.id, userDate, windowStart, windowEnd]
        );

        for (const row of result.rows) {
          try {
            const response = (row.user_response || "").toLowerCase();
            const taskWords = row.task_name.toLowerCase().split(" ").filter(w => w.length > 2);
            const isDoingTask = taskWords.some(word => response.includes(word));

            if (!(await reserveAIQuota(user.id))) {
              // No quota: just mark it and move on silently
              await pool.query("UPDATE tasks SET scolded = true WHERE id = $1", [row.id]);
              continue;
            }

            try {
              if (row.user_response && isDoingTask) {
                const aiPraise = await praiseMessage(row.task_name);
                await sendMessage(user.chat_id, aiPraise);
                await pool.query("UPDATE tasks SET praised = true WHERE id = $1", [row.id]);
              } else {
                const aiAngry = await angryMessage(row.task_name, row.user_response || "nothing");
                await sendMessage(user.chat_id, aiAngry);
                await pool.query("UPDATE tasks SET scolded = true WHERE id = $1", [row.id]);
              }
            } catch (aiErr) {
              await rollbackAIQuota(user.id);
              // Still mark scolded so it doesn't loop forever
              await pool.query("UPDATE tasks SET scolded = true WHERE id = $1", [row.id]);
              console.error(`AI error for task ${row.id}:`, aiErr);
            }
          } catch (err) {
            console.error(`Angry check error for task ${row.id}:`, err);
            await pool.query("UPDATE tasks SET scolded = true WHERE id = $1", [row.id]);
          }
        }
      } catch (err) {
        console.error(`Angry check error for user ${user.id}:`, err);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Discipline cron error:", err);
    res.status(500).json({ ok: false });
  }
});

//--------------
// CRON: Daily summary (~11 PM user time)
// FIXED: Minute range + last_summary_date guard
//--------------
app.post("/cron/daily-summary", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) return res.sendStatus(401);

  try {
    const users = await pool.query("SELECT id, chat_id, timezone_offset FROM users");

    for (const user of users.rows) {
      try {
        const userMinutes = getUserMinutes(user.timezone_offset);
        const userDate = getUserDate(user.timezone_offset);

        // FIXED: Trigger between 23:00–23:09 (9-min window)
        if (userMinutes < 23 * 60 || userMinutes > 23 * 60 + 9) continue;

        const tasksResult = await pool.query(
          `SELECT COUNT(id) AS planned, COUNT(*) FILTER (WHERE praised = true) AS completed
           FROM tasks WHERE user_id = $1 AND task_date = $2`,
          [user.id, userDate]
        );
        const planned = Number(tasksResult.rows[0].planned);
        const completed = Number(tasksResult.rows[0].completed);
        const missed = planned - completed;

        if (planned === 0) continue;

        const success = isSuccessfulDay(planned, completed);

        const statsResult = await pool.query(
          `SELECT current_streak, longest_streak, last_success_date, last_summary_date
           FROM user_stats WHERE user_id = $1`,
          [user.id]
        );

        let currentStreak = 0;
        let longestStreak = 0;
        let lastSuccessDate = null;
        let lastSummaryDate = null;

        if (statsResult.rows.length > 0) {
          ({ current_streak: currentStreak, longest_streak: longestStreak,
             last_success_date: lastSuccessDate, last_summary_date: lastSummaryDate
           } = statsResult.rows[0]);
        }

        // Guard: already sent today
        if (lastSummaryDate === userDate) continue;

        const yesterday = getDatePlusDays(userDate, -1);

        if (success) {
          currentStreak = (lastSuccessDate === yesterday) ? currentStreak + 1 : 1;
          longestStreak = Math.max(longestStreak, currentStreak);

          await pool.query(
            `INSERT INTO user_stats (user_id, current_streak, longest_streak, last_success_date, last_summary_date)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id) DO UPDATE SET
               current_streak = $2, longest_streak = $3,
               last_success_date = $4, last_summary_date = $5`,
            [user.id, currentStreak, longestStreak, userDate, userDate]
          );
        } else {
          await pool.query(
            `INSERT INTO user_stats (user_id, current_streak, longest_streak, last_summary_date)
             VALUES ($1, 0, $2, $3)
             ON CONFLICT (user_id) DO UPDATE SET current_streak = 0, last_summary_date = $3`,
            [user.id, longestStreak, userDate]
          );
        }

        const baseMessage = 
          `📊 Daily Summary\n\nPlanned: ${planned}\nCompleted: ${completed}\nMissed: ${missed}` +
          (success ? `\n\n🔥 Streak: ${currentStreak} day(s)` : `\n\n❌ Streak reset.`);

        if (!(await reserveAIQuota(user.id))) {
          await sendMessage(user.chat_id, baseMessage);
          continue;
        }

        try {
          const aiSummary = await summaryMessage({ planned, completed, missed, success, streak: currentStreak });
          await sendMessage(user.chat_id, `${baseMessage}\n\n${aiSummary}`);
        } catch (aiErr) {
          await rollbackAIQuota(user.id);
          await sendMessage(user.chat_id, baseMessage);
        }
      } catch (err) {
        console.error(`Summary error for user ${user.id}:`, err);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Daily summary cron error:", err);
    res.status(500).json({ ok: false });
  }
});

//--------------
// CRON: Daily reset (run at midnight UTC, per-user timezone aware)
//--------------
app.post("/cron/daily-reset", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) return res.sendStatus(401);

  try {
    const users = await pool.query("SELECT id, timezone_offset FROM users");

    for (const user of users.rows) {
      try {
        const userDate = getUserDate(user.timezone_offset);
        await pool.query(
          `UPDATE tasks SET
             reminder_sent = false, praised = false, scolded = false,
             user_response = NULL, responded_at = NULL
           WHERE user_id = $1 AND task_date < $2`,
          [user.id, userDate]
        );
      } catch (err) {
        console.error(`Reset error for user ${user.id}:`, err);
      }
    }

    lastPlans.clear();
    res.json({ ok: true });
  } catch (err) {
    console.error("Daily reset error:", err);
    res.status(500).json({ ok: false });
  }
});

app.get("/", (_, res) => res.send("Bot is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));