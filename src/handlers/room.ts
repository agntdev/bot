import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import {
  saveRoom,
  readRoom,
  deleteRoom,
  setUserRoom,
  getUserRoom,
  clearUserRoom,
} from "../lib/storage.js";
import { createDeck, shuffleDeck } from "../lib/cards.js";
import type { StoredRoom, StoredGameState, StoredPlayer, StoredCard } from "../lib/storage.js";
import { now, TURN_TIMEOUT_MS, scheduleGameTimer } from "../lib/clock.js";
import {
  publicStateText,
  sendPrivateHandApi,
  formatPlayerListLobby,
} from "../lib/messages.js";
import { handleTurnTimeout } from "./game.js";

// ---- register main-menu items ----
registerMainMenuItem({ label: "🎮 Create", data: "room:create", order: 10 });
registerMainMenuItem({ label: "🚪 Join", data: "room:join", order: 20 });

const composer = new Composer<Ctx>();

// ---- helpers ----

function genRoomId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function formatPlayerList(players: StoredPlayer[], max: number): string {
  const names = players.map((p) => `${p.telegram_name}${p.status === "durak" ? " 💀" : ""}`);
  return `${names.join(", ")}\n\nPlayers: ${players.filter(p => p.status !== "left").length}/${max}`;
}

function makePlayer(uid: number, name: string, status: "lobby" | "playing" = "lobby"): StoredPlayer {
  return { user_id: uid, telegram_name: name, hand: [], status };
}

/** Cleanly leave a user's current room (if any), preserving active games. */
async function leaveCurrentRoom(uid: number): Promise<void> {
  const existingRid = await getUserRoom(uid);
  if (!existingRid) return;

  const existing = await readRoom(existingRid);
  if (!existing) {
    await clearUserRoom(uid);
    return;
  }

  // Never silently leave a room with an active game
  if (existing.game && existing.game.phase !== "ended") {
    return; // caller handles the error message
  }

  // Cleanly leave a lobby room
  existing.players = existing.players.filter((p) => p.user_id !== uid);
  if (existing.players.length === 0) {
    await deleteRoom(existingRid);
  } else {
    if (existing.host_id === uid && existing.players.length > 0) {
      existing.host_id = existing.players[0].user_id;
    }
    await saveRoom(existing);
  }
  await clearUserRoom(uid);
}

// ---- room:create ----

composer.callbackQuery("room:create", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from!.id;
  const name = ctx.from!.first_name || "Player";

  // Check if already in a room with an active game
  const existingRid = await getUserRoom(uid);
  if (existingRid) {
    const existing = await readRoom(existingRid);
    if (existing?.game && existing.game.phase !== "ended") {
      await ctx.reply(
        "You're in an active game right now. Use /leave to drop out of it first, then create a new room.",
        {
          reply_markup: inlineKeyboard([
            [inlineButton("⬅️ Back to menu", "menu:main")],
          ]),
        },
      );
      return;
    }
    // Leave any lobby room
    await leaveCurrentRoom(uid);
  }

  const rid = genRoomId();
  const username = ctx.me?.username ?? "bot";
  const link = `https://t.me/${username}?start=join_${rid}`;
  const room: StoredRoom = {
    room_id: rid,
    host_id: uid,
    max_players: 6,
    initial_hand_size: 6,
    join_link: link,
    players: [makePlayer(uid, name)],
    _version: 0,
  };
  await saveRoom(room);
  await setUserRoom(uid, rid);

  const msg =
    `🎮 Room ${rid} created!\n\n` +
    `Max players: ${room.max_players}   Hand size: ${room.initial_hand_size}\n\n` +
    `Share this link to invite friends:\n${link}\n\n` +
    `Tap ▶️ Start when everyone's in.\n\n` +
    formatPlayerList(room.players, room.max_players);

  await ctx.reply(msg, {
    reply_markup: inlineKeyboard([
      [inlineButton("▶️ Start Game", `game:start:${rid}`),
       inlineButton("⚙️ Settings", `room:settings:${rid}`)],
      [inlineButton("🚪 Leave Room", `leave:${rid}`)],
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
  });
});

// ---- room:settings ----

composer.callbackQuery(/^room:settings:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const room = await readRoom(rid);
  if (!room) {
    await ctx.reply("Room not found — it may have been closed.");
    return;
  }
  if (room.host_id !== ctx.from!.id) {
    await ctx.answerCallbackQuery({ text: "Only the host can change settings.", show_alert: true });
    return;
  }
  if (room.game) {
    await ctx.answerCallbackQuery({ text: "Can't change settings after the game starts.", show_alert: true });
    return;
  }

  const playerCounts = [2, 3, 4, 5, 6];
  const handSizes = [4, 5, 6];

  await ctx.reply(
    `⚙️ Room ${rid} settings\n\n` +
    `Max players: ${room.max_players}\n` +
    `Hand size: ${room.initial_hand_size}\n\n` +
    `Tap a setting to change it:`,
    {
      reply_markup: inlineKeyboard([
        ...playerCounts.map((n) => [
          inlineButton(
            `${n} player${n !== 1 ? "s" : ""}${n === room.max_players ? " ✅" : ""}`,
            `room:setmax:${rid}:${n}`,
          ),
        ]),
        [inlineButton("▬▬▬ Hand size ▬▬▬", "nop:settings")],
        ...handSizes.map((n) => [
          inlineButton(
            `${n} card${n !== 1 ? "s" : ""}${n === room.initial_hand_size ? " ✅" : ""}`,
            `room:sethand:${rid}:${n}`,
          ),
        ]),
        [inlineButton("⬅️ Back to room", `room:refresh:${rid}`)],
      ]),
    },
  );
});

composer.callbackQuery(/^room:setmax:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const val = parseInt(ctx.match![2], 10);
  const room = await readRoom(rid);
  if (!room || room.host_id !== ctx.from!.id) return;
  if (room.game) return;

  room.max_players = val;
  await saveRoom(room);

  const playerCounts = [2, 3, 4, 5, 6];
  const handSizes = [4, 5, 6];

  await ctx.editMessageText(
    `⚙️ Room ${rid} settings\n\n` +
    `Max players: ${room.max_players}\n` +
    `Hand size: ${room.initial_hand_size}\n\n` +
    `Tap a setting to change it:`,
    {
      reply_markup: inlineKeyboard([
        ...playerCounts.map((n) => [
          inlineButton(
            `${n} player${n !== 1 ? "s" : ""}${n === room.max_players ? " ✅" : ""}`,
            `room:setmax:${rid}:${n}`,
          ),
        ]),
        [inlineButton("▬▬▬ Hand size ▬▬▬", "nop:settings")],
        ...handSizes.map((n) => [
          inlineButton(
            `${n} card${n !== 1 ? "s" : ""}${n === room.initial_hand_size ? " ✅" : ""}`,
            `room:sethand:${rid}:${n}`,
          ),
        ]),
        [inlineButton("⬅️ Back to room", `room:refresh:${rid}`)],
      ]),
    },
  );
});

composer.callbackQuery(/^room:sethand:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const val = parseInt(ctx.match![2], 10);
  const room = await readRoom(rid);
  if (!room || room.host_id !== ctx.from!.id) return;
  if (room.game) return;

  room.initial_hand_size = val;
  await saveRoom(room);

  const playerCounts = [2, 3, 4, 5, 6];
  const handSizes = [4, 5, 6];

  await ctx.editMessageText(
    `⚙️ Room ${rid} settings\n\n` +
    `Max players: ${room.max_players}\n` +
    `Hand size: ${room.initial_hand_size}\n\n` +
    `Tap a setting to change it:`,
    {
      reply_markup: inlineKeyboard([
        ...playerCounts.map((n) => [
          inlineButton(
            `${n} player${n !== 1 ? "s" : ""}${n === room.max_players ? " ✅" : ""}`,
            `room:setmax:${rid}:${n}`,
          ),
        ]),
        [inlineButton("▬▬▬ Hand size ▬▬▬", "nop:settings")],
        ...handSizes.map((n) => [
          inlineButton(
            `${n} card${n !== 1 ? "s" : ""}${n === room.initial_hand_size ? " ✅" : ""}`,
            `room:sethand:${rid}:${n}`,
          ),
        ]),
        [inlineButton("⬅️ Back to room", `room:refresh:${rid}`)],
      ]),
    },
  );
});

composer.callbackQuery(/^room:refresh:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const room = await readRoom(rid);
  if (!room) {
    await ctx.reply("Room not found.");
    return;
  }

  const msg =
    `🎮 Room ${room.room_id}\n\n` +
    `Max players: ${room.max_players}   Hand size: ${room.initial_hand_size}\n\n` +
    `Share this link to invite friends:\n${room.join_link}\n\n` +
    `Tap ▶️ Start when everyone's in.\n\n` +
    formatPlayerList(room.players, room.max_players);

  await ctx.reply(msg, {
    reply_markup: inlineKeyboard([
      [inlineButton("▶️ Start Game", `game:start:${rid}`),
       inlineButton("⚙️ Settings", `room:settings:${rid}`)],
      [inlineButton("🚪 Leave Room", `leave:${rid}`)],
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
  });
});

// ---- room:join ----

composer.callbackQuery("room:join", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_join_link";
  await ctx.reply(
    "Paste the room invite link or the room code (6 letters/numbers):",
    { reply_markup: { force_reply: true, input_field_placeholder: "Room link or code…" } },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_join_link") return next();
  const text = ctx.message.text.trim();

  const match = text.match(/join_([A-Z0-9]{6})$/i) ?? text.match(/^([A-Z0-9]{6})$/i);
  if (!match) {
    await ctx.reply("That doesn't look like a room code. It should be 6 letters/numbers — try again.");
    return;
  }
  const rid = match[1].toUpperCase();
  await handleJoinRoom(ctx, rid);
});

// ---- join_ link: handle /start join_XXXXXX via text detection ----

composer.on("message:text", async (ctx, next) => {
  const text = ctx.message.text.trim();
  const match = text.match(/^\/start\s+join_([A-Z0-9]{6})$/i);
  if (!match) return next();

  const rid = match[1].toUpperCase();
  await handleJoinByDeepLink(ctx, rid);
});

async function handleJoinByDeepLink(ctx: Ctx, rid: string): Promise<void> {
  const uid = ctx.from!.id;

  // Check if user is already in another room
  const existingRid = await getUserRoom(uid);
  if (existingRid && existingRid !== rid) {
    const existing = await readRoom(existingRid);
    if (existing?.game && existing.game.phase !== "ended") {
      await ctx.reply(
        "You're in an active game right now. Use /leave to drop out of it first, then join a new one.",
      );
      return;
    }
    // Leave the old lobby room silently
    await leaveCurrentRoom(uid);
  }

  // Proceed with join
  await doJoinRoom(ctx, rid, uid);
}

async function handleJoinRoom(ctx: Ctx, rid: string): Promise<void> {
  const uid = ctx.from!.id;
  ctx.session.step = undefined;

  const room = await readRoom(rid);

  if (!room) {
    await ctx.reply("Couldn't find that room — it may have ended. Ask the host for a fresh invite link.");
    return;
  }

  if (room.game) {
    await ctx.reply("That game's already in progress — wait for the next one!");
    return;
  }

  if (room.players.filter((p) => p.status !== "left").length >= room.max_players) {
    await ctx.reply("The room's full — wait for the next game.");
    return;
  }

  if (room.players.some((p) => p.user_id === uid && p.status !== "left")) {
    await ctx.reply("You're already in this room!");
    return;
  }

  // Check if user is in another room — let them know
  const existingRid = await getUserRoom(uid);
  if (existingRid && existingRid !== rid) {
    const existing = await readRoom(existingRid);
    if (existing?.game && existing.game.phase !== "ended") {
      await ctx.reply(
        "You're in an active game already. Use /leave to drop out first, then try joining again.",
      );
      return;
    }
    await leaveCurrentRoom(uid);
  }

  await doJoinRoom(ctx, rid, uid);
}

async function doJoinRoom(ctx: Ctx, rid: string, uid: number): Promise<void> {
  const room = await readRoom(rid);
  if (!room) {
    await ctx.reply("Couldn't find that room — it may have ended. Ask the host for a fresh invite link.");
    return;
  }

  const existing = room.players.find((p) => p.user_id === uid);
  if (existing) {
    existing.status = "lobby";
  } else {
    const name = ctx.from!.first_name || "Player";
    room.players.push(makePlayer(uid, name));
  }

  await saveRoom(room);
  await setUserRoom(uid, rid);

  await ctx.reply(
    `🚪 Joined room ${rid}!\n\n${formatPlayerList(room.players, room.max_players)}`,
  );

  // Notify other players in the room
  const joinerName = ctx.from!.first_name || "Player";
  for (const p of room.players) {
    if (p.user_id !== uid && p.status !== "left") {
      try {
        await ctx.api.sendMessage(
          p.user_id,
          `👋 ${joinerName} joined the room!\n\n${formatPlayerList(room.players, room.max_players)}`,
        );
      } catch {}
    }
  }
}

// ---- game:start ----

composer.callbackQuery(/^game:start:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const room = await readRoom(rid);
  if (!room) {
    await ctx.reply("Room not found — it may have been closed.");
    return;
  }
  if (room.host_id !== ctx.from!.id) {
    await ctx.reply("Only the host can start the game.");
    return;
  }
  const activePlayers = room.players.filter((p) => p.status !== "left");
  if (activePlayers.length < 2) {
    await ctx.reply("Need at least 2 players to start — invite more friends!");
    return;
  }

  // Create and shuffle deck
  const deck = shuffleDeck(createDeck());
  const handSize = room.initial_hand_size;

  // Deal to players
  for (const p of activePlayers) {
    p.hand = deck.splice(0, handSize);
    p.status = "playing";
  }

  // Trump card — bottom of deck
  const trumpCard = deck[deck.length - 1];
  const trumpSuit = trumpCard.suit;

  const game: StoredGameState = {
    players: activePlayers,
    deck,
    trump_card: trumpCard,
    trump_suit: trumpSuit,
    discard: [],
    table: [],
    attacker_idx: 0,
    defender_idx: 1,
    phase: "attack",
    turn_deadline: now() + TURN_TIMEOUT_MS,
    room_id: rid,
    host_id: room.host_id,
  };

  room.game = game;
  room.players = activePlayers;
  await saveRoom(room);

  // Schedule the first proactive turn timer
  scheduleGameTimer(rid, async () => {
    const fresh = await readRoom(rid);
    if (!fresh?.game || fresh.game.phase === "ended") return;
    if (now() >= fresh.game.turn_deadline) {
      await handleTurnTimeout(ctx.api, fresh.game, rid, fresh);
    }
  }, TURN_TIMEOUT_MS);

  // Send public game state to ALL players
  const publicText = publicStateText(game);
  for (const p of activePlayers) {
    try {
      await ctx.api.sendMessage(p.user_id, publicText);
    } catch {
      // user blocked — continue
    }
  }

  // Send private hands to each player
  for (const p of activePlayers) {
    await sendPrivateHandApi(ctx.api, game, p, rid);
  }
});

// ---- Export for proactive timer usage ----

export { sendPrivateHandApi, publicStateText };

// ---- Broadcast helpers ----

// Re-export the broadcast from messages module so old references still work
import { broadcastPublicStateApi } from "../lib/messages.js";
export async function broadcastPublicState(
  ctx: { api: import("grammy").Api },
  game: StoredGameState,
): Promise<void> {
  return broadcastPublicStateApi(ctx.api, game);
}

export async function sendPrivateHand(
  ctx: { api: import("grammy").Api },
  game: StoredGameState,
  player: StoredPlayer,
  rid: string,
): Promise<void> {
  return sendPrivateHandApi(ctx.api, game, player, rid);
}

export default composer;
