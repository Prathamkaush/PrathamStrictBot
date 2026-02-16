import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* =========================
   TOKEN SAFETY (TEST PHASE)
========================= */

// Max tokens you allow per day (for YOU only)
const DAILY_TOKEN_LIMIT = 10000;

let tokensUsedToday = 0;
let lastResetDate = new Date().toISOString().split("T")[0];

function estimateTokens(systemPrompt, userPrompt, maxTokens = 150) {
  const inputTokens =
    Math.ceil(systemPrompt.length / 4) +
    Math.ceil(userPrompt.length / 4);

  return inputTokens + maxTokens;
}

function consumeTokens(tokens) {
  const today = new Date().toISOString().split("T")[0];

  if (today !== lastResetDate) {
    tokensUsedToday = 0;
    lastResetDate = today;
  }

  if (tokensUsedToday + tokens > DAILY_TOKEN_LIMIT) {
    throw new Error("DAILY_TOKEN_LIMIT_EXCEEDED");
  }

  tokensUsedToday += tokens;
}

/* =========================
   Core AI helper
========================= */
async function askAI(systemPrompt, userPrompt) {
  const estimatedTokens = estimateTokens(systemPrompt, userPrompt);
  consumeTokens(estimatedTokens);

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
    `You are a discipline coach starting the day.`,
    `User has ${todayTaskCount} tasks today.`
  );
}

/* =========================
   📌 PLANNING PROMPT
========================= */
export async function planningPrompt() {
  return askAI(
    `You are a discipline coach at night.`,
    `Remind user to plan tomorrow.`
  );
}
