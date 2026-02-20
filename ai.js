import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* =========================
   Core AI helper
   NOTE: Daily quota is managed in index.js via reserveAIQuota() (DB-backed).
   The old in-memory token counter was removed because it resets on every
   server restart/sleep (Render free tier restarts frequently), making it useless.
========================= */
async function askAI(systemPrompt, userPrompt) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.7,
    max_tokens: 150,
  });

  return response.choices[0].message.content.trim();
}

/* =========================
   😌 PRAISE MODE
========================= */
export async function praiseMessage(taskName) {
  return askAI(
    `You are a strict but caring discipline coach. When someone completes their task, give brief genuine praise with a warm tone. Use emojis like 😌, ✅, 💪, 🎯. Keep it under 2 sentences.`,
    `The user planned "${taskName}" and they're doing it right now on time.`
  );
}

/* =========================
   😡 ANGRY MODE
========================= */
export async function angryMessage(taskName, userResponse) {
  return askAI(
    `You are a strict discipline coach who holds people accountable. Be direct and firm. Use 😡, ⚠️, 💢. 2–3 short sentences.`,
    `Planned: "${taskName}". User did: "${userResponse}".`
  );
}

/* =========================
   📊 DAILY SUMMARY
========================= */
export async function summaryMessage({ planned, completed, missed, success, streak }) {
  return askAI(
    `You are a discipline mentor. ${success ? "Celebrate but push harder." : "Be firm but motivating."}`,
    `Planned ${planned}, completed ${completed}, missed ${missed}, streak ${streak}.`
  );
}

/* =========================
   🧠 STUCK MODE
========================= */
export async function stuckHelp(problem) {
  return askAI(
    `You are a practical productivity coach. Give 2–3 actionable micro-steps.`,
    `User is stuck: "${problem}".`
  );
}

/* =========================
   🌅 MORNING
========================= */
export async function morningMessage(todayTaskCount) {
  return askAI(
    `You are a discipline coach starting the day. Be energetic and motivating. Use 🌅 or ☀️. Keep it under 2 sentences.`,
    `User has ${todayTaskCount} tasks today.`
  );
}

/* =========================
   📌 PLANNING PROMPT
========================= */
export async function planningPrompt() {
  return askAI(
    `You are a discipline coach at night. Encourage the user to plan tomorrow so they wake up with purpose. Use 📌 or 🌙. Keep it under 2 sentences.`,
    `Remind user to plan tomorrow.`
  );
}