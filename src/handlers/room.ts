import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";

registerMainMenuItem({ label: "🎮 Create", data: "room:create", order: 10 });
registerMainMenuItem({ label: "🚪 Join", data: "room:join", order: 20 });

type Card = { rank: string; suit: string };
type Player = { user_id: number; telegram_name: string; hand: Card[]; status: string };
type Room = {
  room_id: string;
  host_id: number;
  max_players: number;
  initial_hand_size: number;
  join_link: string;
  players: Player[];
  game?: any;
};

import { MemorySessionStorage } from "../toolkit/session/memory.js";
const roomStore = new MemorySessionStorage<Room>();

function genRoomId(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

const composer = new Composer<Ctx>();

composer.callbackQuery("room:create", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from!.id;
  const name = ctx.from!.first_name || "Player";
  const rid = genRoomId();
  const link = `https://t.me/${ctx.me.username}?start=join_${rid}`;
  const room: Room = {
    room_id: rid,
    host_id: uid,
    max_players: 6,
    initial_hand_size: 6,
    join_link: link,
    players: [{ user_id: uid, telegram_name: name, hand: [], status: "lobby" }],
  };
  await roomStore.write(rid, room);
  const msg = `Room ${rid} created! Share this link to invite friends:\n${link}\n\nPlayers: 1/6\nTap Start when ready.`;
  await ctx.editMessageText(msg, {
    reply_markup: inlineKeyboard([
      [inlineButton("▶️ Start Game", `game:start:${rid}`)],
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
  });
});

composer.callbackQuery("room:join", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_join_link";
  await ctx.reply("Paste the room invite link or code:", { reply_markup: { force_reply: true } });
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_join_link") return next();
  const text = ctx.message.text.trim();
  const match = text.match(/join_([A-Z0-9]{6})|([A-Z0-9]{6})/);
  if (!match) {
    await ctx.reply("Invalid link or code — check and try again.");
    return;
  }
  const rid = match[1] || match[2];
  const room = await roomStore.read(rid);
  if (!room) {
    await ctx.reply("Room not found — link may have expired.");
    ctx.session.step = undefined;
    return;
  }
  if (room.players.length >= room.max_players) {
    await ctx.reply("Room is full.");
    ctx.session.step = undefined;
    return;
  }
  const uid = ctx.from.id;
  if (room.players.some((p) => p.user_id === uid)) {
    await ctx.reply("You're already in this room.");
    ctx.session.step = undefined;
    return;
  }
  const name = ctx.from.first_name || "Player";
  room.players.push({ user_id: uid, telegram_name: name, hand: [], status: "lobby" });
  await roomStore.write(rid, room);
  ctx.session.step = undefined;
  await ctx.reply(`Joined room ${rid}! Players: ${room.players.length}/${room.max_players}`);
});

composer.command("hand", async (ctx) => {
  const uid = ctx.from!.id;
  // find room by scanning? but avoided — use simple assumption or index not now. For slice: reply no game.
  await ctx.reply("No active game — join or create a room first.");
});

export default composer;
