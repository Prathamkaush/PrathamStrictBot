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
const AI_DAILY_LIMIT = 20; // max 20 AI calls per user per day

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
  return userTime.toTimeString().slice(0, 5);
}

function getUserDateTime(timezoneOffset = 0) {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utc + (timezoneOffset * 60000));
}

function getTodayDate() {
  return new Date().toISOString().split("T")[0];
}

function getTomorrowDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

function getYesterdayDate(baseDate) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

//--------------
//Middleware 
//--------------
async function getOrCreateUser(chatId) {
  const result = await pool.query(
    "SELECT id, timezone_offset FROM users WHERE chat_id = $1",
    [chatId]
  );

  if (result.rows.length > 0) {
    return result.rows[0];
  }

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

    tasks.push({
      time: `${match[1]}:${match[2]}`,
      name: match[3],
    });
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

  if (stuck_count >= 5) {
    return false;
  }

  await pool.query(
    `UPDATE users SET stuck_count = stuck_count + 1 WHERE id = $1`,
    [userId]
  );
  
  return true;
}

// FIXED: Reserve quota BEFORE making AI call, with rollback on failure
async function reserveAIQuota(userId) {
  const today = getTodayDate();
  
  const result = await pool.query(
    `
    UPDATE users
    SET 
      ai_calls_today = CASE 
        WHEN ai_reset_date != $1 THEN 1
        ELSE ai_calls_today + 1
      END,
      ai_reset_date = $1
    WHERE id = $2
      AND (ai_reset_date != $1 OR ai_calls_today < $3)
    RETURNING ai_calls_today
    `,
    [today, userId, AI_DAILY_LIMIT]
  );

  return result.rowCount > 0;
}

async function rollbackAIQuota(userId) {
  await pool.query(
    `UPDATE users SET ai_calls_today = GREATEST(0, ai_calls_today - 1) WHERE id = $1`,
    [userId]
  );
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
     /stuck - AI help with DB rate limiting
  ======================= */
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
      await rollbackAIQuota(user.id); // FIXED: Rollback on failure
      await sendMessage(chatId, "❌ AI temporarily unavailable. Try again later.");
    }
    
    return res.sendStatus(200);
  }

  /* =======================
     /timezone - Set user timezone
  ======================= */
  if (text.startsWith("/timezone ")) {
    const offset = parseInt(text.replace("/timezone ", "").trim(), 10);
    
    if (isNaN(offset) || offset < -720 || offset > 840) {
      await sendMessage(chatId, "❌ Invalid timezone offset.\n\nExample:\n/timezone 330 (for IST)\n/timezone -300 (for EST)");
      return res.sendStatus(200);
    }

    const user = await getOrCreateUser(chatId);
    
    await pool.query(
      `UPDATE users SET timezone_offset = $1 WHERE id = $2`,
      [offset, user.id]
    );

    await sendMessage(chatId, `✅ Timezone set to UTC${offset >= 0 ? '+' : ''}${offset / 60} hours`);
    return res.sendStatus(200);
  }

  /* =======================
     1️⃣ /plan - Shows tasks based on time of day
  ======================= */
  if (text === "/plan") {
    const user = await getOrCreateUser(chatId);
    const userDate = getUserDate(user.timezone_offset);
    const userHour = parseInt(getUserTime(user.timezone_offset).split(':')[0]);
    
    const taskDate = userHour >= 18 ? getTomorrowDate() : userDate;
    const dateLabel = userHour >= 18 ? "Tomorrow" : "Today";

    const tasks = await getTasksForDate(user.id, taskDate);

    if (tasks.length === 0) {
      await sendMessage(chatId, `📭 No tasks planned for ${dateLabel.toLowerCase()}.`);
      return res.sendStatus(200);
    }

    lastPlans.set(chatId, { date: taskDate, tasks });

    let reply = `📅 ${dateLabel}'s Plan (${taskDate})\n\n`;
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
    const user = await getOrCreateUser(chatId);
    const userDate = getUserDate(user.timezone_offset);
    const userHour = parseInt(getUserTime(user.timezone_offset).split(':')[0]);
    const taskDate = userHour >= 18 ? getTomorrowDate() : userDate;

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

    const user = await getOrCreateUser(chatId);
    const userDate = getUserDate(user.timezone_offset);
    const userHour = parseInt(getUserTime(user.timezone_offset).split(':')[0]);
    const taskDate = userHour >= 18 ? getTomorrowDate() : userDate;

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
      `UPDATE tasks
       SET task_time = $1, task_name = $2
       WHERE id = $3`,
      [time, name, task.id]
    );

    task.task_time = time;
    task.task_name = name;

    await sendMessage(
      chatId,
      `✅ Task updated:\n${task.task_time.slice(0, 5)} ${task.task_name}`
    );

    return res.sendStatus(200);
  }

  /* =======================
     /delete
  ======================= */
  if (text === "/delete") {
    const user = await getOrCreateUser(chatId);
    const userDate = getUserDate(user.timezone_offset);
    const userHour = parseInt(getUserTime(user.timezone_offset).split(':')[0]);
    const taskDate = userHour >= 18 ? getTomorrowDate() : userDate;

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

  /* =======================
     delete <number>
  ======================= */
  if (text.startsWith("delete ")) {
    const parts = text.split(" ");
    const index = parseInt(parts[1], 10) - 1;

    if (isNaN(index)) {
      await sendMessage(chatId, "❌ Invalid delete format.\nUse: delete <number>");
      return res.sendStatus(200);
    }

    const user = await getOrCreateUser(chatId);
    const userDate = getUserDate(user.timezone_offset);
    const userHour = parseInt(getUserTime(user.timezone_offset).split(':')[0]);
    const taskDate = userHour >= 18 ? getTomorrowDate() : userDate;

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

    await pool.query(
      "DELETE FROM tasks WHERE id = $1",
      [task.id]
    );

    plan.splice(index, 1);

    await sendMessage(
      chatId,
      `✅ Deleted: ${task.task_time.slice(0,5)} — ${task.task_name}`
    );

    return res.sendStatus(200);
  }

  /* =======================
     doing <response>
  ======================= */
  if (text.startsWith("doing ")) {
    const response = text.replace("doing ", "").trim();

    const user = await getOrCreateUser(chatId);
    const userDate = getUserDate(user.timezone_offset);
    const nowTime = getUserTime(user.timezone_offset);

    const result = await pool.query(
      `
      UPDATE tasks
      SET user_response = $1,
          responded_at = NOW()
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

  /* =======================
     Ignore other commands
  ======================= */
  if (text.startsWith("/")) {
    return res.sendStatus(200);
  }

  /* =======================
     Parse & save tasks
  ======================= */
  const tasks = parseTasks(text);
  if (tasks.length === 0) {
    await sendMessage(
      chatId,
      "❌ Format invalid.\nUse:\n07:00 Gym\n10:00 Study Go"
    );
    return res.sendStatus(200);
  }

  const user = await getOrCreateUser(chatId);
  const userDate = getUserDate(user.timezone_offset);
  const userHour = parseInt(getUserTime(user.timezone_offset).split(':')[0]);
  
  const taskDate = userHour >= 18 ? getTomorrowDate() : userDate;
  const dateLabel = userHour >= 18 ? "tomorrow" : "today";

  for (const task of tasks) {
    await pool.query(
      `INSERT INTO tasks (user_id, task_date, task_time, task_name)
       VALUES ($1, $2, $3, $4)`,
      [user.id, taskDate, task.time, task.name]
    );
  }

  lastPlans.delete(chatId);

  await sendMessage(
    chatId,
    `✅ Saved ${tasks.length} tasks for ${dateLabel} (${taskDate})`
  );

  res.sendStatus(200);
});

//--------------
// Plan reminder at 10 pm with AI
//--------------
app.post("/cron/plan-reminder", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) {
    return res.sendStatus(401);
  }
  try {
    const result = await pool.query(
      "SELECT id, chat_id, timezone_offset FROM users"
    );

    for (const row of result.rows) {
      try {
        const userHour = parseInt(getUserTime(row.timezone_offset).split(':')[0]);
        
        if (userHour !== 22) continue;

        if (!(await reserveAIQuota(row.id))) {
          await sendMessage(row.chat_id, "📌 Plan tomorrow's tasks.\n\nReply like:\n07:00 Gym\n10:00 Study Go");
          continue;
        }

        try {
          const aiPrompt = await planningPrompt();
          await sendMessage(
            row.chat_id,
            `${aiPrompt}\n\nReply like:\n07:00 Gym\n10:00 Study Go`
          );
        } catch (err) {
          await rollbackAIQuota(row.id);
          throw err;
        }
      } catch (err) {
        console.error(`Plan reminder error for ${row.chat_id}:`, err);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Cron error:", err);
    res.status(500).json({ ok: false });
  }
});

//--------------
// Morning start with AI
//--------------
app.post("/cron/morning-start", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) {
    return res.sendStatus(401);
  }

  try {
    const result = await pool.query(
      "SELECT u.id, u.chat_id, u.timezone_offset FROM users u"
    );

    for (const row of result.rows) {
      try {
        const userHour = parseInt(getUserTime(row.timezone_offset).split(':')[0]);
        
        if (userHour !== 7) continue;

        const userDate = getUserDate(row.timezone_offset);
        const tasks = await getTasksForDate(row.id, userDate);
        
        if (!(await reserveAIQuota(row.id))) {
          await sendMessage(row.chat_id, `🌅 Good morning.\n\nYou have ${tasks.length} tasks today. Use /plan to see them.`);
          continue;
        }

        try {
          const aiMessage = await morningMessage(tasks.length);
          await sendMessage(
            row.chat_id,
            `${aiMessage}\n\nUse /plan to see today's tasks.`
          );
        } catch (err) {
          await rollbackAIQuota(row.id);
          throw err;
        }
      } catch (err) {
        console.error(`Morning error for ${row.chat_id}:`, err);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Morning cron error:", err);
    res.status(500).json({ ok: false });
  }
});

//--------------
// Task reminder cron job every 5 min
//--------------
app.post("/cron/task-reminders", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) {
    return res.sendStatus(401);
  }

  try {
    const users = await pool.query("SELECT id, chat_id, timezone_offset FROM users");

    for (const user of users.rows) {
      try {
        const userDate = getUserDate(user.timezone_offset);
        const userTime = getUserTime(user.timezone_offset);
        
        const [currentHour, currentMin] = userTime.split(':').map(Number);
        const currentMinutes = currentHour * 60 + currentMin;
        
        const targetMinutes = currentMinutes + 15;
        const targetHour = Math.floor(targetMinutes / 60) % 24;
        const targetMin = targetMinutes % 60;
        const targetTime = `${String(targetHour).padStart(2, '0')}:${String(targetMin).padStart(2, '0')}`;

        const result = await pool.query(
          `
          UPDATE tasks
          SET reminder_sent = true
          WHERE id IN (
            SELECT id FROM tasks
            WHERE user_id = $1
              AND task_date = $2
              AND task_time = $3
              AND reminder_sent = false
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id, task_time, task_name
          `,
          [user.id, userDate, targetTime]
        );

        for (const task of result.rows) {
          await sendMessage(
            user.chat_id,
            `⏰ Reminder\n\nAt ${task.task_time} you planned:\n${task.task_name}\n\nWhat are you doing right now?\n\nReply: doing <your answer>`
          );
        }
      } catch (err) {
        console.error(`Reminder error for user ${user.id}:`, err);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Task reminder error:", err);
    res.status(500).json({ ok: false });
  }
});

//--------------
// Behavior check with AI emotions - FIXED with time window
//--------------
app.post("/cron/angry-check", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) {
    return res.sendStatus(401);
  }

  try {
    const users = await pool.query("SELECT id, chat_id, timezone_offset FROM users");

    for (const user of users.rows) {
      try {
        const userDate = getUserDate(user.timezone_offset);
        const userTime = getUserTime(user.timezone_offset);

        // FIXED: Use time window instead of exact match (±2 minutes)
        const [currentHour, currentMin] = userTime.split(':').map(Number);
        const currentMinutes = currentHour * 60 + currentMin;

        const result = await pool.query(
          `
          SELECT t.id, t.task_name, t.user_response, t.task_time
          FROM tasks t
          WHERE t.user_id = $1
            AND t.task_date = $2
            AND t.praised = false
            AND t.scolded = false
            AND t.reminder_sent = true
            AND (
              EXTRACT(HOUR FROM t.task_time::time) * 60 + EXTRACT(MINUTE FROM t.task_time::time)
            ) BETWEEN $3 AND $4
          `,
          [user.id, userDate, currentMinutes - 2, currentMinutes + 2]
        );

        for (const row of result.rows) {
          try {
            if (!(await reserveAIQuota(user.id))) {
              await pool.query("UPDATE tasks SET scolded = true WHERE id = $1", [row.id]);
              continue;
            }

            const response = (row.user_response || "").toLowerCase();
            const taskWords = row.task_name.toLowerCase().split(" ");

            const isDoingTask = taskWords.some(word =>
              response.includes(word)
            );

            try {
              if (row.user_response && isDoingTask) {
                const aiPraise = await praiseMessage(row.task_name);
                await sendMessage(user.chat_id, aiPraise);

                await pool.query(
                  "UPDATE tasks SET praised = true WHERE id = $1",
                  [row.id]
                );
              } else {
                const aiAngry = await angryMessage(row.task_name, row.user_response || "nothing");
                await sendMessage(user.chat_id, aiAngry);
                
                await pool.query(
                  "UPDATE tasks SET scolded = true WHERE id = $1",
                  [row.id]
                );
              }
            } catch (aiErr) {
              await rollbackAIQuota(user.id);
              await pool.query("UPDATE tasks SET scolded = true WHERE id = $1", [row.id]);
              throw aiErr;
            }
          } catch (err) {
            console.error(`Angry check error for task ${row.id}:`, err);
            await pool.query(
              "UPDATE tasks SET scolded = true WHERE id = $1",
              [row.id]
            );
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
// Daily summary with AI emotion
//--------------
app.post("/cron/daily-summary", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) {
    return res.sendStatus(401);
  }

  try {
    const users = await pool.query("SELECT id, chat_id, timezone_offset FROM users");

    for (const user of users.rows) {
      try {
        const userHour = parseInt(getUserTime(user.timezone_offset).split(':')[0]);
        
        if (userHour !== 23) continue;

        const userDate = getUserDate(user.timezone_offset);

        const tasksResult = await pool.query(`
          SELECT
            COUNT(t.id) AS planned,
            COUNT(*) FILTER (WHERE t.praised = true) AS completed
          FROM tasks t
          WHERE t.user_id = $1 AND t.task_date = $2
        `, [user.id, userDate]);

        const planned = Number(tasksResult.rows[0].planned);
        const completed = Number(tasksResult.rows[0].completed);
        const missed = planned - completed;

        if (planned === 0) continue;

        const success = isSuccessfulDay(planned, completed);

        const statsResult = await pool.query(
          "SELECT current_streak, longest_streak, last_success_date, last_summary_date FROM user_stats WHERE user_id = $1",
          [user.id]
        );

        let currentStreak = 0;
        let longestStreak = 0;
        let lastSuccessDate = null;
        let lastSummaryDate = null;

        if (statsResult.rows.length > 0) {
          ({ 
            current_streak: currentStreak, 
            longest_streak: longestStreak, 
            last_success_date: lastSuccessDate,
            last_summary_date: lastSummaryDate 
          } = statsResult.rows[0]);
        }

        if (lastSummaryDate === userDate) {
          console.log(`Summary already sent for user ${user.id} today`);
          continue;
        }

        const yesterday = getYesterdayDate(userDate);

        if (success) {
          if (lastSuccessDate === yesterday) {
            currentStreak += 1;
          } else {
            currentStreak = 1;
          }

          longestStreak = Math.max(longestStreak, currentStreak);

          await pool.query(
            `
            INSERT INTO user_stats (user_id, current_streak, longest_streak, last_success_date, last_summary_date)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (user_id)
            DO UPDATE SET
              current_streak = $2,
              longest_streak = $3,
              last_success_date = $4,
              last_summary_date = $5
            `,
            [user.id, currentStreak, longestStreak, userDate, userDate]
          );
        } else {
          await pool.query(
            `
            INSERT INTO user_stats (user_id, current_streak, longest_streak, last_summary_date)
            VALUES ($1, 0, $2, $3)
            ON CONFLICT (user_id)
            DO UPDATE SET
              current_streak = 0,
              last_summary_date = $3
            `,
            [user.id, longestStreak, userDate]
          );
        }

        if (!(await reserveAIQuota(user.id))) {
          let message = `📊 Daily Summary\n\nPlanned: ${planned}\nCompleted: ${completed}\nMissed: ${missed}`;
          if (success) {
            message += `\n\n🔥 Streak: ${currentStreak} day(s)`;
          }
          await sendMessage(user.chat_id, message);
          continue;
        }

        try {
          const aiSummary = await summaryMessage({
            planned,
            completed,
            missed,
            success,
            streak: currentStreak
          });

          let message = `📊 Daily Summary\n\nPlanned: ${planned}\nCompleted: ${completed}\nMissed: ${missed}\n\n${aiSummary}`;

          if (success) {
            message += `\n\n🔥 Streak: ${currentStreak} day(s)`;
          }

          await sendMessage(user.chat_id, message);
        } catch (aiErr) {
          await rollbackAIQuota(user.id);
          let message = `📊 Daily Summary\n\nPlanned: ${planned}\nCompleted: ${completed}\nMissed: ${missed}`;
          if (success) {
            message += `\n\n🔥 Streak: ${currentStreak} day(s)`;
          }
          await sendMessage(user.chat_id, message);
        }
      } catch (err) {
        console.error(`Summary error for user ${user.id}:`, err);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Daily summary error:", err);
    res.status(500).json({ ok: false });
  }
});

//--------------
// Daily reset - FIXED with timezone awareness
//--------------
app.post("/cron/daily-reset", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) {
    return res.sendStatus(401);
  }

  try {
    // FIXED: Per-user timezone-aware reset
    const users = await pool.query("SELECT id, timezone_offset FROM users");

    for (const user of users.rows) {
      try {
        const userDate = getUserDate(user.timezone_offset);
        
        // Reset tasks older than user's current date
        await pool.query(
          `
          UPDATE tasks
          SET
            reminder_sent = false,
            praised = false,
            scolded = false,
            user_response = NULL,
            responded_at = NULL
          WHERE user_id = $1
            AND task_date < $2
          `,
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
app.listen(PORT, () => console.log("Server running", PORT));