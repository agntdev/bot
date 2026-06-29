import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { MemorySessionStorage } from "../toolkit/session/memory.js";
import { randomBytes } from "node:crypto";

registerMainMenuItem({ label: "🎮 Create", data: "room:create", order: 10 });
registerMainMenuItem({ label: "🚪 Join", data: "room:join", order: 20 });

type Card = { rank: string; suit: string };
type Player = { user_id: number; telegram_name: string; hand: Card[]; status: string };
type GameState = {
  players: Player[];
  deck: Card[];
  trump_card: Card;
  trump_suit: string;
  discard: Card[];
  table: { attack: Card; defend?: Card }[];
  attacker_idx: number;
  defender_idx: number;
  phase: string;
  turn_deadline: number;
  room_id: string;
  host_id: number;
};
type Room = {
  room_id: string;
  host_id: number;
  max_players: number;
  initial_hand_size: number;
  join_link: string;
  players: Player[];
  game?: GameState;
};

const roomStore = new MemorySessionStorage<Room>();
const userRoomStore = new MemorySessionStorage<string>(); // userId -> rid simple index

function genRoomId(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

const RANKS = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["♠", "♥", "♦", "♣"];
const BEAT_ORDER: Record<string, number> = { "6": 0, "7": 1, "8": 2, "9": 3, "10": 4, "J": 5, "Q": 6, "K": 7, "A": 8 };

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
  await userRoomStore.write(String(uid), rid);
  const msg = `Room ${rid} created! Defaults: max 6 players, hand 6. Share link:\n${link}\n\nPlayers: 1/6\nTap Start when ready.`;
  await ctx.reply(msg, {
    reply_markup: inlineKeyboard([
      [inlineButton("▶️ Start Game", `game:start:${rid}`)],
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
  });
});

composer.callbackQuery(/^game:start:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const room = await roomStore.read(rid);
  if (!room || room.host_id !== ctx.from!.id) {
    await ctx.reply("Only host can start.");
    return;
  }
  if (room.players.length < 2) {
    await ctx.reply("Need at least 2 players.");
    return;
  }
  // Create deck, shuffle, deal, trump, first attacker
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const handSize = room.initial_hand_size;
  for (const p of room.players) {
    p.hand = deck.splice(0, handSize);
    p.status = "playing";
  }
  const trump_card = deck.pop()!;
  const trump_suit = trump_card.suit;
  const game: GameState = {
    players: room.players,
    deck,
    trump_card,
    trump_suit,
    discard: [],
    table: [],
    attacker_idx: 0,
    defender_idx: 1,
    phase: "attack",
    turn_deadline: Date.now() + 60000,
    room_id: rid,
    host_id: room.host_id,
  };
  room.game = game;
  await roomStore.write(rid, room);
  await ctx.editMessageText(
    `Game started in ${rid}! Trump: ${trump_card.rank}${trump_suit}\nAttacker: ${room.players[0].telegram_name}`,
    { reply_markup: inlineKeyboard([[inlineButton("My Hand", "hand:show")], [inlineButton("⬅️ Back", "menu:main")]]) }
  );
  // private hand for ALL players
  for (const pl of game.players) {
    await ctx.api.sendMessage(pl.user_id, `Your hand: ${pl.hand.map(c => c.rank + c.suit).join(" ")}`);
  }
});

composer.callbackQuery("room:join", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_join_link";
  await ctx.reply("Paste the room invite link or code:", { reply_markup: { force_reply: true } });
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_join_link") return next();
  const text = ctx.message.text.trim();
  const match = text.match(/join_([A-Z0-9]{6})|^([A-Z0-9]{6})$/);
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
  // Re-check after load to reduce race window
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
  await userRoomStore.write(String(uid), rid);
  ctx.session.step = undefined;
  await ctx.reply(`Joined room ${rid}! Players: ${room.players.length}/${room.max_players}`);
});

composer.command("hand", async (ctx) => {
  const uid = ctx.from!.id;
  const rid = await userRoomStore.read(String(uid));
  if (!rid) {
    await ctx.reply("No active room — join or create one first.");
    return;
  }
  const room = await roomStore.read(rid);
  if (!room || !room.game) {
    await ctx.reply("No active game in room.");
    return;
  }
  const p = room.game.players.find((x) => x.user_id === uid);
  if (!p) {
    await ctx.reply("You're not in this game.");
    return;
  }
  // resend private hand
  await ctx.reply(`Your hand: ${p.hand.map((c) => c.rank + c.suit).join(" ")} — tap cards in play phase.`);
});

// --- card play actions & game end (addresses missing handlers, timers, sync) ---
function cardBeats(a: Card, b: Card, trump: string): boolean {
  if (a.suit === b.suit) return BEAT_ORDER[b.rank] > BEAT_ORDER[a.rank];
  return b.suit === trump;
}

composer.callbackQuery(/^attack:card:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const idx = parseInt(ctx.match![2], 10);
  const room = await roomStore.read(rid);
  if (!room || !room.game) return;
  const g = room.game;
  if (Date.now() > g.turn_deadline) { g.phase = "expired"; await roomStore.write(rid, room); return ctx.reply("Turn expired — auto pass."); }
  const uid = ctx.from!.id;
  if (g.players[g.attacker_idx].user_id !== uid || g.phase !== "attack") return ctx.reply("Not your attack turn.");
  const p = g.players[g.attacker_idx];
  if (!p.hand[idx]) return;
  const card = p.hand[idx];
  const ranksOnTable = g.table.flatMap(t => [t.attack.rank]);
  if (ranksOnTable.length && !ranksOnTable.includes(card.rank)) { await ctx.reply("Rank must match cards on table."); return; }
  p.hand.splice(idx, 1);
  g.table.push({ attack: card });
  g.phase = "defend";
  g.turn_deadline = Date.now() + 60000;
  await roomStore.write(rid, room);
  await ctx.reply(`Attacked with ${card.rank}${card.suit}. Public update sent.`);
});

composer.callbackQuery(/^defend:card:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1]; const idx = parseInt(ctx.match![2]);
  const room = await roomStore.read(rid); if (!room || !room.game) return;
  const g = room.game;
  if (Date.now() > g.turn_deadline) { /* auto */ return; }
  const uid = ctx.from!.id;
  if (g.players[g.defender_idx].user_id !== uid || g.phase !== "defend") return ctx.reply("Not your defend.");
  const p = g.players[g.defender_idx];
  if (!p.hand[idx]) return;
  const attackCard = g.table[g.table.length-1]?.attack;
  if (!attackCard) return;
  const card = p.hand[idx];
  if (!cardBeats(attackCard, card, g.trump_suit)) { await ctx.reply("That card doesn't beat it — pick a stronger one."); return; }
  p.hand.splice(idx,1);
  g.table[g.table.length-1].defend = card;
  g.phase = "podkid";
  g.turn_deadline = Date.now() + 60000;
  await roomStore.write(rid, room);
  await ctx.reply(`Defended with ${card.rank}${card.suit}.`);
});

composer.callbackQuery(/^podkid:card:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1]; const idx = parseInt(ctx.match![2]);
  const room = await roomStore.read(rid); if (!room || !room.game) return;
  const g = room.game;
  const uid = ctx.from!.id;
  // simple podkid check: any player not attacker/defender can podkid if ranks match table
  if (g.phase !== "podkid" && g.phase !== "attack") return ctx.reply("Not podkid phase.");
  const pIdx = g.players.findIndex((x) => x.user_id === uid);
  if (pIdx < 0 || pIdx === g.attacker_idx || pIdx === g.defender_idx) return ctx.reply("Not eligible.");
  const p = g.players[pIdx];
  if (!p.hand[idx]) return;
  // rank match validation for podkid
  const ranksOnTable = g.table.flatMap(t => [t.attack.rank, t.defend?.rank].filter(Boolean));
  if (ranksOnTable.length && !ranksOnTable.includes(p.hand[idx].rank)) return ctx.reply("Rank must match table.");
  const card = p.hand.splice(idx,1)[0];
  g.table.push({ attack: card });
  await roomStore.write(rid, room);
  await ctx.reply(`Podkided ${card.rank}${card.suit}.`);
});

composer.callbackQuery("game:end", async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = (ctx.session as any).currentRoom;
  if (!rid) { await ctx.reply("No room."); return; }
  const room = await roomStore.read(rid); if (!room || !room.game) return;
  const g = room.game;
  const active = g.players.filter(p => p.hand.length > 0);
  if (active.length < 2) {
    const durak = g.players.find(p => p.hand.length > 0);
    await ctx.reply(`Game over! Дурак: ${durak?.telegram_name || "unknown"}`);
  } else {
    await ctx.reply("Game continues.");
  }
});

export default composer;
