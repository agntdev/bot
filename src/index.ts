import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error("BOT_TOKEN is required");
    process.exit(1);
  }
  const bot = await buildBot(token);
  // Publish the "/" command list to Telegram (discoverability). A button-first
  // bot exposes /start + /help + /hand; everything else is reached via menu buttons.
  await setDefaultCommands(bot, [
    { command: "hand", description: "Show your hand of cards" },
    { command: "leave", description: "Leave the current room or game" },
  ]);
  bot.start();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
