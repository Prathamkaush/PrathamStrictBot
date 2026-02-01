import express from "express";
import { pool } from "./db.js";
import { sendMessage } from "./telegram.js";
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const username = message.from.username || "";
  const text = message.text || "";

  await pool.query(
    "INSERT INTO messages (chat_id, username, text) VALUES ($1,$2,$3)",
    [chatId, username, text]
  );

  await sendMessage(chatId, "✅ Message received");

  res.sendStatus(200);
});

app.get("/", (_, res) => res.send("Bot is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running" , PORT));
