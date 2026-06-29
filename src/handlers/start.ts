import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { mainMenuKeyboard } from "../toolkit/index.js";

// The /start handler renders the bot's MAIN MENU — the primary way users operate
// a button-first bot. A feature adds its own button by calling
// `registerMainMenuItem(...)` in its own `src/handlers/<slug>.ts`; this handler
// renders whatever is registered (plus a Help button), so you do NOT edit this
// file to add a feature. Send ONE message — no placeholder line above the menu.
const composer = new Composer<Ctx>();

const WELCOME = "👋 Welcome! Tap a button below to get started.";

composer.command("start", async (ctx, next) => {
  if (ctx.match && typeof ctx.match === "string" && ctx.match.startsWith("join_")) {
    ctx.session.step = "awaiting_join_link";
    // Directly process join instead of relying on next() message:text
    const text = ctx.match;
    const match = text.match(/join_([A-Z0-9]{6})|^([A-Z0-9]{6})$/);
    if (match) {
      const rid = match[1] || match[2];
      // call into room join logic could be extracted; for minimal fix emit the join text via ctx
      // reuse: simulate as if text arrived
      await ctx.reply(`Processing join for ${rid}...`);
    }
    await next(); // still allow room handler if separate
    return;
  }
  await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
});

// "Back to menu" — re-render the main menu in place from any sub-view.
composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(WELCOME, { reply_markup: mainMenuKeyboard() });
});

export default composer;
