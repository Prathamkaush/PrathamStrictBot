# 🧠 Discipline AI – Telegram Productivity Bot

A **timezone-aware AI-powered discipline & productivity bot** for Telegram that helps users plan tasks, stay accountable, build streaks, and receive real-time AI feedback.

This project is currently built **for personal use and experimentation**, with strict AI usage limits and cost control.  
Future scalability and monetization are planned if the system proves effective.

---

## 🚀 Features

- 📅 Time-based task planning
- ⏰ Automatic task reminders
- ✍️ Real-time user accountability (`doing <response>`)
- 😌 AI praise when on track
- 😡 AI scolding when off track
- 🔥 Daily streak tracking
- 📊 AI-powered daily summaries
- 🌅 Morning motivation
- 🌙 Evening planning reminder
- 🧠 AI help when stuck
- 🌍 Fully timezone-aware
- 🔐 Safe AI usage limits with rollback on failure

---

## 🧱 Tech Stack

- **Node.js**
- **Express**
- **PostgreSQL**
- **Telegram Bot API**
- **OpenAI API (gpt-4o-mini)**
- **Cron Jobs**
- **Supabase / Neon compatible**

---

## 🧠 How the Bot Works (Flow)

1. User sets timezone
2. User plans tasks with time
3. Bot sends reminder 15 minutes before task
4. User replies with `doing <response>`
5. AI evaluates behavior:
   - Praise if aligned
   - Scold if not
6. Tasks counted toward daily success
7. AI summary + streak sent at night
8. Data resets automatically at midnight

---

## 🕒 Timezone Support
/timezone <offset>


### Examples

| Region | Command |
|------|------|
| IST | `/timezone 330` |
| EST | `/timezone -300` |
| PST | `/timezone -480` |

All reminders and cron jobs run based on **user local time**, not server time.

---

## 📌 Telegram Commands

### 📅 Add Tasks
Send tasks in this format:


07:00 Gym
10:00 Study Go
16:30 Project Work


**Rules**
- Before 6 PM → saved for today
- After 6 PM → saved for tomorrow

---

### 📋 `/plan`
Shows your tasks  
- Before 6 PM → Today  
- After 6 PM → Tomorrow  

---

### ✏️ `/edit`
Edit a task.

Steps:
1. `/plan`
2. `/edit`
3. Reply:


edit 2 11:00 Study Maths


---

### 🗑️ `/delete`
Delete a task.

Steps:
1. `/delete`
2. Reply:


delete 1


---

### ✍️ `doing <response>`
Tell the bot what you're doing after a reminder.

Example:


doing studying maths


Used by AI to decide praise or scolding.

---

### 🧠 `/stuck <problem>`
Get AI-generated micro-steps when stuck.

Example:


/stuck can't focus on studying


---

## 🤖 AI Usage Limits (Cost Controlled)

| Limit | Value |
|------|------|
| AI calls per user/day | **20** |
| `/stuck` calls/day | **5** |
| AI failure | Quota rollback |
| Quota exceeded | Text-only fallback |

This keeps the project safe for **personal testing and low-cost usage**.

---

## ⏱️ Automated Cron Jobs

| Cron | Time (User Local) | Purpose |
|----|----|----|
| Morning Start | 7:00 AM | Motivation |
| Task Reminder | Every 5 min | Remind 15 min before task |
| Behavior Check | Around task time | Praise / Scold |
| Plan Reminder | 10:00 PM | Plan tomorrow |
| Daily Summary | 11:00 PM | AI summary + streak |
| Daily Reset | Midnight | Reset task states |

All cron routes are protected using `x-cron-secret`.

---

## 🔥 Streak Rules

- Successful day = **≥ 70% tasks completed**
- Consecutive success → streak increases
- Failure → streak resets
- Longest streak preserved

---

## 🗄️ Database Tables

- `users`
- `tasks`
- `user_stats`

Tracks:
- Timezone
- AI usage
- Stuck limits
- Task state
- Streak history

---

## 🧪 Testing Checklist

- [ ] `/timezone` set correctly
- [ ] Morning message at 7 AM
- [ ] Reminder 15 minutes before task
- [ ] `doing` captured
- [ ] AI praise or scold sent once
- [ ] `/stuck` respects limit
- [ ] Daily summary sent once
- [ ] Streak updates correctly

---

## ⚠️ Disclaimer

This project is **currently designed for personal use**.  
AI limits, database design, and cron frequency are intentionally conservative.

Scaling, billing, and multi-user monetization are **future goals**.

---

## 📜 License

MIT License

---

## 🙌 Author

**Pratham Kaushik**  
MCA Student | Backend & Systems Builder  
Telegram AI · Automation · Discipline Systems
Each user must set their timezone once:

