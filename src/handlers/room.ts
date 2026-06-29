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
} from "../lib/storage.js";
import { createDeck, shuffleDeck } from "../lib/cards.js";
import type { StoredRoom, StoredGameState, StoredPlayer, StoredCard } from "../lib/storage.js";
import { now, TURN_TIMEOUT_MS } from "../lib/clock.js";

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

// ---- room:create ----

composer.callbackQuery("room:create", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from!.id;
  const name = ctx.from!.first_name || "Player";

  // Check if already in a room — leave it first
  const existingRid = await getUserRoom(uid);
  if (existingRid) {
    const existing = await readRoom(existingRid);
    if (existing && !existing.game) {
      existing.players = existing.players.filter((p) => p.user_id !== uid);
      if (existing.players.length === 0) {
        await deleteRoom(existingRid);
      } else {
        await saveRoom(existing);
      }
    }
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
  };
  await saveRoom(room);
  await setUserRoom(uid, rid);

  const msg =
    `🎮 Room ${rid} created!\n\n` +
    `Share this link to invite friends:\n${link}\n\n` +
    `Tap ▶️ Start when everyone's in.\n\n` +
    formatPlayerList(room.players, room.max_players);

  await ctx.reply(msg, {
    reply_markup: inlineKeyboard([
      [inlineButton("▶️ Start Game", `game:start:${rid}`)],
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
  const room = await readRoom(rid);

  if (!room) {
    await ctx.reply("Couldn't find that room — it may have ended. Ask the host for a fresh invite link.");
    ctx.session.step = undefined;
    return;
  }

  if (room.game) {
    await ctx.reply("That game's already in progress — wait for the next one!");
    ctx.session.step = undefined;
    return;
  }

  if (room.players.filter((p) => p.status !== "left").length >= room.max_players) {
    await ctx.reply("The room's full — wait for the next game.");
    ctx.session.step = undefined;
    return;
  }

  const uid = ctx.from!.id;
  if (room.players.some((p) => p.user_id === uid && p.status !== "left")) {
    await ctx.reply("You're already in this room!");
    ctx.session.step = undefined;
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
  ctx.session.step = undefined;

  await ctx.reply(
    `🚪 Joined room ${rid}!\n\n${formatPlayerList(room.players, room.max_players)}`,
  );
});

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

  // Send public game state to ALL players (DMs)
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
    await sendPrivateHand(ctx, game, p, rid);
  }
});

// ---- join_ link: handle /start join_XXXXXX via text detection ----
// When a user taps a t.me/...?start=join_XXXXXX link, Telegram sends /start join_XXXXXX
// grammY's command("start") will match first, but we need to catch the join_ payload.
// We do this via a text-message handler that runs early and checks for /start join_ pattern.

composer.on("message:text", async (ctx, next) => {
  const text = ctx.message.text.trim();
  const match = text.match(/^\/start\s+join_([A-Z0-9]{6})$/i);
  if (!match) return next();

  const rid = match[1].toUpperCase();
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

  const uid = ctx.from!.id;
  if (room.players.some((p) => p.user_id === uid && p.status !== "left")) {
    await ctx.reply("You're already in this room!");
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
});

// ---- Exports for use by game.ts ----

export function publicStateText(g: StoredGameState): string {
  const tableStr =
    g.table.length === 0
      ? "(empty)"
      : g.table
          .map((p) => `${p.attack.rank}${p.attack.suit}${p.defend ? " vs " + p.defend.rank + p.defend.suit : " → ?"}`)
          .join("\n");
  const attacker = g.players[g.attacker_idx].telegram_name;
  const defender = g.players[g.defender_idx].telegram_name;
  const phaseLabel = { attack: "⚔️ Attack", defend: "🛡 Defend", podkid: "🎯 Podkid", take: "⛔ Taking", ended: "🏁 Ended" }[g.phase];
  const deckInfo = `Deck: ${g.deck.length} card${g.deck.length !== 1 ? "s" : ""}`;

  return (
    `🃏 ${g.room_id}\n\n` +
    `Trump: ${g.trump_card.rank}${g.trump_suit}   ${deckInfo}\n\n` +
    `Table:\n${tableStr}\n\n` +
    `${phaseLabel}: ${attacker} → ${defender}\n\n` +
    `Players: ${g.players.map((p) => p.telegram_name + (p.status === "durak" ? " 💀" : "") + (p.hand.length ? ` (${p.hand.length})` : "")).join(", ")}`
  );
}

export async function sendPrivateHand(
  ctx: Ctx,
  game: StoredGameState,
  player: StoredPlayer,
  rid: string,
): Promise<void> {
  const uid = player.user_id;
  const hand = player.hand;

  if (hand.length === 0) {
    return;
  }

  const isAttacker = game.players[game.attacker_idx]?.user_id === uid;
  const isDefender = game.players[game.defender_idx]?.user_id === uid;

  // Determine if this player can act right now and what action prefix to use.
  let canAct = false;
  let actionPrefix = "";
  if (game.phase === "attack" && isAttacker) {
    canAct = true;
    actionPrefix = "atk";
  } else if (game.phase === "defend" && isDefender) {
    canAct = true;
    actionPrefix = "def";
  } else if (game.phase === "podkid" && !isDefender && isPlayerActiveInGame(player, game)) {
    canAct = true;
    actionPrefix = "pod";
  }

  const isWaiting = !canAct;

  // Build card buttons (3 per row) — only if the player can act.
  const rows: ReturnType<typeof inlineButton>[][] = [];
  for (let i = 0; i < hand.length; i += 3) {
    rows.push(
      hand.slice(i, i + 3).map((c: StoredCard, j: number) => {
        const idx = i + j;
        if (!canAct) {
          // Show text labels without callbacks so tapping does nothing —
          // avoid creating buttons with empty action prefixes that never
          // get answered, which causes the Telegram spinner to hang.
          return inlineButton(`· ${c.rank}${c.suit}`, `nop:${rid}`);
        }
        return inlineButton(`${c.rank}${c.suit}`, `${actionPrefix}:${rid}:${idx}`);
      }),
    );
  }

  // Action buttons
  const actionRow: ReturnType<typeof inlineButton>[] = [];
  if (game.phase === "attack" && isAttacker && game.table.length > 0) {
    actionRow.push(inlineButton("✅ Done attacking", `done:${rid}`));
  }
  if (game.phase === "defend" && isDefender) {
    actionRow.push(inlineButton("⛔ Take cards", `take:${rid}`));
  }
  if (game.phase === "podkid" && !isDefender && isPlayerActiveInGame(player, game)) {
    actionRow.push(inlineButton("✅ Done tossing", `done:${rid}`));
  }

  const buttons = [...rows];
  if (actionRow.length > 0) buttons.push(actionRow);

  const phaseLabel =
    game.phase === "attack" && isAttacker
      ? "🎯 Your turn to attack!"
      : game.phase === "defend" && isDefender
        ? "🛡 Defend!"
        : game.phase === "podkid" && !isDefender && isPlayerActiveInGame(player, game)
          ? "🎯 Toss more cards in!"
          : "⏳ Waiting...";

  const tableStr =
    game.table.length === 0
      ? "(empty)"
      : game.table
          .map((p) => `${p.attack.rank}${p.attack.suit}${p.defend ? " vs " + p.defend.rank + p.defend.suit : " → ?"}`)
          .join("\n");

  const text =
    `${phaseLabel}\n\n` +
    `Trump: ${game.trump_card.rank}${game.trump_suit}   Deck: ${game.deck.length}\n\n` +
    `Table:\n${tableStr}\n\n` +
    `Your hand (${hand.length} card${hand.length !== 1 ? "s" : ""}):` +
    (isWaiting ? `\n\n_It's not your turn — sit tight!_` : "");

  try {
    await ctx.api.sendMessage(uid, text, {
      reply_markup: { inline_keyboard: buttons },
    });
  } catch {
    // user blocked bot — skip
  }
}

/** Check if a player is an active participant (not left / durak). */
function isPlayerActiveInGame(p: StoredPlayer, _g: StoredGameState): boolean {
  return p.status === "playing";
}

// ---- nop: catch-all for non-playable card taps ----
// When a player who can't act taps a card button, it sends nop:ROOMID.
// Answer the callback query so Telegram's spinner doesn't hang, and show
// an ephemeral alert telling the user why they can't play.

composer.callbackQuery(/^nop:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "It's not your turn — wait for your go!", show_alert: false });
});

// ---- catch-all for unknown game-related callback data — prevents stuck spinners ----
// Any callback_queries that start with a known game-action prefix but aren't
// handled by a specific handler land here, so the Telegram spinner is always
// answered instead of spinning forever with no visible action.

composer.on("callback_query", async (ctx, next) => {
  const data = ctx.callbackQuery.data;
  if (!data) return next();
  // Only guard game-action callbacks (atk:, def:, pod:, take:, done:).
  // Everything else (menu:*, game:start:*, help buttons, etc.) passes through.
  const gamePrefixes = ["atk:", "def:", "pod:", "take:", "done:", "nop:"];
  const isGame = gamePrefixes.some((p) => data.startsWith(p));
  if (!isGame) return next();

  console.warn("[room] unhandled game callback", {
    userId: ctx.from?.id,
    callbackData: data,
  });
  try {
    await ctx.answerCallbackQuery({ text: "That action isn't available right now.", show_alert: false });
  } catch {
    // best effort
  }
});

export async function broadcastPublicState(
  ctx: Ctx,
  game: StoredGameState,
): Promise<void> {
  const text = publicStateText(game);
  for (const p of game.players) {
    if (p.status === "left" || p.status === "durak") continue;
    try {
      await ctx.api.sendMessage(p.user_id, text);
    } catch {
      // blocked — skip
    }
  }
}

export default composer;
