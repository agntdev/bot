import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton } from "../toolkit/index.js";
import {
  readRoom,
  saveRoom,
  getUserRoom,
  type StoredGameState,
  type StoredPlayer,
  type StoredCard,
  type StoredRoom,
} from "../lib/storage.js";
import { cardBeats, cardToString, tableRanks } from "../lib/cards.js";
import { now, TURN_TIMEOUT_MS } from "../lib/clock.js";
import {
  publicStateText,
  sendPrivateHand,
  broadcastPublicState,
} from "./room.js";

const composer = new Composer<Ctx>();

// ---- helpers ----

function initialHandSize(room: StoredRoom): number {
  return room.initial_hand_size;
}

function drawCards(game: StoredGameState, count: number): StoredCard[] {
  const drawn: StoredCard[] = [];
  while (count > 0 && game.deck.length > 0) {
    drawn.push(game.deck.pop()!);
    count--;
  }
  return drawn;
}

function refillHand(game: StoredGameState, player: StoredPlayer, upTo: number): void {
  const needed = Math.max(0, upTo - player.hand.length);
  if (needed > 0) {
    const drawn = drawCards(game, needed);
    player.hand.push(...drawn);
  }
}

function nextAttackerDefender(game: StoredGameState): void {
  const curDefIdx = game.defender_idx;
  let newAttIdx = (curDefIdx + 1) % game.players.length;
  while (game.players[newAttIdx].status !== "playing" && newAttIdx !== curDefIdx) {
    newAttIdx = (newAttIdx + 1) % game.players.length;
  }
  game.attacker_idx = newAttIdx;

  let newDefIdx = (newAttIdx + 1) % game.players.length;
  while (game.players[newDefIdx].status !== "playing" && newDefIdx !== newAttIdx) {
    newDefIdx = (newDefIdx + 1) % game.players.length;
  }
  game.defender_idx = newDefIdx;
}

function checkGameEnd(g: StoredGameState): boolean {
  for (const p of g.players) {
    if (p.status === "playing" && p.hand.length === 0 && g.deck.length === 0) {
      p.status = "durak";
    }
  }
  const playingNow = g.players.filter((p) => p.status === "playing");
  if (playingNow.length < 2) {
    g.phase = "ended";
    return true;
  }
  return false;
}

function isPlayerActive(p: StoredPlayer): boolean {
  return p.status === "playing";
}

// ---- defensive helpers ----

interface LoadedRoom {
  room: StoredRoom;
  game: StoredGameState;
}

/**
 * Load a room and its game with a full set of defensive checks.
 * Returns null + sends an error to the user if anything is wrong.
 * This centralises the boilerplate so every handler doesn't repeat it.
 */
async function loadRoomGame(
  ctx: Ctx,
  rid: string,
): Promise<LoadedRoom | null> {
  const room = await readRoom(rid);
  if (!room) {
    console.warn("[game] room not found", { rid, userId: ctx.from?.id });
    try { await ctx.reply("Room not found — it may have been closed."); } catch {}
    return null;
  }
  if (!room.game) {
    console.warn("[game] no game in room", { rid });
    try { await ctx.reply("No game in progress — wait for the host to start."); } catch {}
    return null;
  }
  if (room.game.phase === "ended") {
    try { await ctx.reply("That game's already over!"); } catch {}
    return null;
  }
  return { room, game: room.game };
}

/**
 * Check turn expiry. Returns null + handles timeout if game is stale.
 */
async function checkTurnDeadline(
  ctx: Ctx,
  g: StoredGameState,
  rid: string,
  room: StoredRoom,
): Promise<boolean> {
  if (now() > g.turn_deadline) {
    console.warn("[game] turn expired on handler entry", { rid, phase: g.phase });
    try { await ctx.reply("⏰ This turn's timed out — the game moved on."); } catch {}
    // Trigger timeout so the game advances
    await handleTurnTimeout(ctx, g, rid, room);
    return false;
  }
  return true;
}

/**
 * Validate card index is in bounds. Returns null + ephemeral error if not.
 */
function validateCardIndex(
  ctx: Ctx,
  player: StoredPlayer,
  idx: number,
): boolean {
  if (!player.hand[idx]) {
    console.warn("[game] card index out of bounds", {
      userId: player.user_id,
      idx,
      handSize: player.hand.length,
    });
    try {
      ctx.answerCallbackQuery({ text: "That card isn't in your hand.", show_alert: false });
    } catch {}
    return false;
  }
  return true;
}

// ---- attack:card callback ----

composer.callbackQuery(/^atk:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const idx = parseInt(ctx.match![2], 10);
  const uid = ctx.from!.id;

  console.log("[game] attack:card", { rid, idx, uid });

  const loaded = await loadRoomGame(ctx, rid);
  if (!loaded) return;
  const { room, game: g } = loaded;

  // Defensive: turn deadline
  if (!(await checkTurnDeadline(ctx, g, rid, room))) return;

  // Defensive: valid attacker index
  const attacker = g.players[g.attacker_idx];
  if (!attacker) {
    console.error("[game] invalid attacker_idx", { rid, attacker_idx: g.attacker_idx });
    await ctx.reply("Something's wrong with the game state — ask the host to restart.");
    return;
  }

  // Defensive: user is the attacker
  if (attacker.user_id !== uid) {
    console.warn("[game] non-attacker tapped attack card", {
      rid, uid, attackerId: attacker.user_id, phase: g.phase,
    });
    // Could be a podkid attempt — forward it
    if (g.phase === "podkid" && g.players[g.defender_idx]?.user_id !== uid) {
      return handlePodkid(ctx, g, rid, uid, idx, room);
    }
    await ctx.answerCallbackQuery({ text: "Not your turn to attack.", show_alert: true });
    return;
  }

  // Defensive: correct phase
  if (g.phase !== "attack") {
    await ctx.reply("Not the attack phase right now.");
    return;
  }

  // Defensive: card index in bounds
  if (!validateCardIndex(ctx, attacker, idx)) return;

  // Defensive: rank matching rule check
  if (g.table.length > 0) {
    const ranks = tableRanks(g.table);
    if (!ranks.has(attacker.hand[idx].rank)) {
      await ctx.reply("You can only play a card matching a rank already on the table.");
      return;
    }
  }

  // ---- Atomically mutate state ----
  const card = attacker.hand.splice(idx, 1)[0];
  g.table.push({ attack: card });
  g.phase = "defend";
  g.turn_deadline = now() + TURN_TIMEOUT_MS;

  console.log("[game] attack played", {
    rid, uid, card: cardToString(card), tableSize: g.table.length,
  });

  await saveRoom(room);
  await broadcastPublicState(ctx, g);
  await sendPrivateHand(ctx, g, attacker, rid);
  await sendPrivateHand(ctx, g, g.players[g.defender_idx], rid);
});

// ---- defend:card callback ----

composer.callbackQuery(/^def:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const idx = parseInt(ctx.match![2], 10);
  const uid = ctx.from!.id;

  console.log("[game] defend:card", { rid, idx, uid });

  const loaded = await loadRoomGame(ctx, rid);
  if (!loaded) return;
  const { room, game: g } = loaded;

  // Defensive: turn deadline
  if (!(await checkTurnDeadline(ctx, g, rid, room))) return;

  // Defensive: valid defender index
  const defender = g.players[g.defender_idx];
  if (!defender) {
    console.error("[game] invalid defender_idx", { rid, defender_idx: g.defender_idx });
    await ctx.reply("Something's wrong with the game state — ask the host to restart.");
    return;
  }

  // Defensive: user is the defender
  if (defender.user_id !== uid) {
    console.warn("[game] non-defender tapped defend card", {
      rid, uid, defenderId: defender.user_id, phase: g.phase,
    });
    await ctx.answerCallbackQuery({ text: "Not your turn to defend.", show_alert: true });
    return;
  }

  // Defensive: correct phase
  if (g.phase !== "defend") {
    await ctx.reply("Not the defend phase right now.");
    return;
  }

  // Defensive: card index in bounds
  if (!validateCardIndex(ctx, defender, idx)) return;

  // Defensive: there's an undefended attack
  const undefendedIdx = g.table.findIndex((p) => !p.defend);
  if (undefendedIdx === -1) {
    await ctx.reply("All attacks are covered — tap Done or toss in more cards.");
    return;
  }

  const attack = g.table[undefendedIdx].attack;
  const defendCard = defender.hand[idx];

  // Defensive: card beats check
  if (!cardBeats(attack, defendCard, g.trump_suit)) {
    await ctx.reply(
      `${cardToString(defendCard)} can't beat ${cardToString(attack)}. Pick a higher rank of the same suit or a trump.`,
    );
    return;
  }

  // ---- Atomically mutate state ----
  defender.hand.splice(idx, 1);
  g.table[undefendedIdx].defend = defendCard;

  console.log("[game] defended", {
    rid, uid, defendCard: cardToString(defendCard), vs: cardToString(attack),
  });

  const allDefended = g.table.every((p) => p.defend);
  if (allDefended) {
    g.phase = "podkid";
    g.turn_deadline = now() + TURN_TIMEOUT_MS;
  }

  await saveRoom(room);
  await broadcastPublicState(ctx, g);
  await sendPrivateHand(ctx, g, defender, rid);
});

// ---- podkid helper ----

async function handlePodkid(
  ctx: Ctx,
  g: StoredGameState,
  rid: string,
  uid: number,
  idx: number,
  room: StoredRoom,
): Promise<void> {
  const player = g.players.find((p) => p.user_id === uid);
  if (!player || player.status !== "playing") {
    console.warn("[game] podkid by non-playing user", { rid, uid });
    await ctx.answerCallbackQuery({ text: "You're not playing in this game.", show_alert: true });
    return;
  }

  // Defensive: card index in bounds
  if (!player.hand[idx]) {
    console.warn("[game] podkid card index out of bounds", { rid, uid, idx, handSize: player.hand.length });
    await ctx.answerCallbackQuery({ text: "That card isn't in your hand.", show_alert: false });
    return;
  }

  // Defensive: rank matching
  const ranks = tableRanks(g.table);
  if (!ranks.has(player.hand[idx].rank)) {
    await ctx.answerCallbackQuery({ text: "You can only toss in a card matching a rank already on the table.", show_alert: true });
    return;
  }

  // Defender can handle at most 6 attacks (initial hand size)
  if (g.table.length >= 6) {
    await ctx.answerCallbackQuery({ text: "Max attacks on the table already — tap Done.", show_alert: true });
    return;
  }

  // ---- Atomically mutate state ----
  const card = player.hand.splice(idx, 1)[0];
  g.table.push({ attack: card });

  console.log("[game] podkid card", {
    rid, uid, card: cardToString(card), tableSize: g.table.length,
  });

  await saveRoom(room);
  await broadcastPublicState(ctx, g);
  await sendPrivateHand(ctx, g, player, rid);
  await sendPrivateHand(ctx, g, g.players[g.defender_idx], rid);
}

// ---- podkid:card callback ----

composer.callbackQuery(/^pod:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const idx = parseInt(ctx.match![2], 10);
  const uid = ctx.from!.id;

  console.log("[game] podkid:card", { rid, idx, uid });

  const loaded = await loadRoomGame(ctx, rid);
  if (!loaded) return;
  const { room, game: g } = loaded;

  // Defensive: turn deadline
  if (!(await checkTurnDeadline(ctx, g, rid, room))) return;

  // Defensive: valid defender index
  const defender = g.players[g.defender_idx];
  if (!defender) {
    console.error("[game] invalid defender_idx in podkid", { rid });
    await ctx.reply("Something's wrong with the game state.");
    return;
  }

  // Defensive: correct phase
  if (g.phase !== "podkid") {
    await ctx.reply("Not the podkid phase right now.");
    return;
  }

  // Defensive: defender can't podkid
  if (defender.user_id === uid) {
    await ctx.reply("Defender can't toss cards in — only defend or take.");
    return;
  }

  return handlePodkid(ctx, g, rid, uid, idx, room);
});

// ---- take action ----

composer.callbackQuery(/^take:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const uid = ctx.from!.id;

  console.log("[game] take", { rid, uid });

  const loaded = await loadRoomGame(ctx, rid);
  if (!loaded) return;
  const { room, game: g } = loaded;

  // Defensive: valid defender index
  const defender = g.players[g.defender_idx];
  if (!defender) {
    console.error("[game] invalid defender_idx in take", { rid });
    await ctx.reply("Something's wrong with the game state.");
    return;
  }

  // Defensive: user is the defender
  if (defender.user_id !== uid) {
    console.warn("[game] non-defender tried to take", { rid, uid, defenderId: defender.user_id });
    await ctx.answerCallbackQuery({ text: "Only the defender can take cards.", show_alert: true });
    return;
  }

  // Defensive: correct phase
  if (g.phase !== "defend" && g.phase !== "podkid") {
    await ctx.reply("Not the right phase to take cards.");
    return;
  }

  // ---- Atomically mutate state ----
  for (const pair of g.table) {
    defender.hand.push(pair.attack);
    if (pair.defend) defender.hand.push(pair.defend);
  }
  const takenCount = g.table.reduce((n, p) => n + 1 + (p.defend ? 1 : 0), 0);
  g.table = [];

  // Refill all non-defender players to hand size
  const upTo = initialHandSize(room);
  for (const p of g.players) {
    if (p.user_id !== defender.user_id && isPlayerActive(p)) {
      refillHand(g, p, upTo);
    }
  }

  // Skip the attacker's turn (defender took — they don't advance to attack)
  g.phase = "attack";
  g.turn_deadline = now() + TURN_TIMEOUT_MS;

  console.log("[game] defender took cards", { rid, uid, takenCount });

  await saveRoom(room);
  await broadcastPublicState(ctx, g);

  await sendPrivateHand(ctx, g, defender, rid);
  for (const p of g.players) {
    if (p.user_id !== defender.user_id && isPlayerActive(p)) {
      await sendPrivateHand(ctx, g, p, rid);
    }
  }
});

// ---- done action ----

composer.callbackQuery(/^done:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const uid = ctx.from!.id;

  console.log("[game] done", { rid, uid });

  const loaded = await loadRoomGame(ctx, rid);
  if (!loaded) return;
  const { room, game: g } = loaded;

  if (g.phase === "attack") {
    if (g.table.length === 0) {
      await ctx.reply("You have to play at least one card first.");
      return;
    }
    const attacker = g.players[g.attacker_idx];
    if (!attacker || attacker.user_id !== uid) {
      console.warn("[game] non-attacker tried done in attack phase", { rid, uid, attackerId: attacker?.user_id });
      await ctx.answerCallbackQuery({ text: "Only the current attacker can finish.", show_alert: true });
      return;
    }

    const anyUndefended = g.table.some((p) => !p.defend);
    if (anyUndefended) {
      g.phase = "podkid";
      g.turn_deadline = now() + TURN_TIMEOUT_MS;
      console.log("[game] attacker done → podkid phase", { rid });
      await saveRoom(room);
      await broadcastPublicState(ctx, g);
      for (const p of g.players) {
        if (p.user_id !== g.players[g.defender_idx]?.user_id && isPlayerActive(p)) {
          await sendPrivateHand(ctx, g, p, rid);
        }
      }
      return;
    }

    await advanceTurn(ctx, g, rid, room);
    return;
  }

  if (g.phase === "podkid") {
    const allDefended = g.table.every((p) => p.defend);
    if (!allDefended) {
      await ctx.reply("Wait — some attacks are still undefended.");
      return;
    }

    console.log("[game] done in podkid phase → advance turn", { rid, uid });
    await advanceTurn(ctx, g, rid, room);
    return;
  }

  await ctx.reply("Nothing to finish right now.");
});

async function advanceTurn(
  ctx: Ctx,
  g: StoredGameState,
  rid: string,
  room: StoredRoom,
): Promise<void> {
  const beatCount = g.table.reduce((n, p) => n + 1 + (p.defend ? 1 : 0), 0);
  for (const pair of g.table) {
    g.discard.push(pair.attack);
    if (pair.defend) g.discard.push(pair.defend);
  }
  g.table = [];

  const upTo = initialHandSize(room);
  const startIdx = g.attacker_idx;
  for (let i = 0; i < g.players.length; i++) {
    const p = g.players[(startIdx + i) % g.players.length];
    if (isPlayerActive(p)) {
      refillHand(g, p, upTo);
    }
  }

  if (g.deck.length === 0) {
    for (const p of g.players) {
      if (isPlayerActive(p) && p.hand.length === 0) {
        p.status = "durak";
      }
    }
  }

  if (checkGameEnd(g)) {
    console.log("[game] game ended", { rid, beatCount });
    await saveRoom(room);
    await broadcastGameEnd(ctx, g);
    return;
  }

  const oldAttacker = g.players[g.attacker_idx]?.telegram_name;
  nextAttackerDefender(g);
  g.phase = "attack";
  g.turn_deadline = now() + TURN_TIMEOUT_MS;
  console.log("[game] turn advanced", { rid, newAttacker: g.players[g.attacker_idx]?.telegram_name, beatCount });

  await saveRoom(room);
  await broadcastPublicState(ctx, g);

  for (const p of g.players) {
    if (isPlayerActive(p)) {
      await sendPrivateHand(ctx, g, p, rid);
    }
  }
}

async function broadcastGameEnd(ctx: Ctx, g: StoredGameState): Promise<void> {
  const durak = g.players.find((p) => p.status === "durak");
  const durakName = durak ? durak.telegram_name : "Unknown";
  const text =
    `🏁 Game over!\n\n` +
    `${durakName} is the durak! 👑💀\n\n` +
    `Final standings:\n` +
    g.players.map((p) => `${p.telegram_name} — ${p.status === "durak" ? "💀 дурак" : `${p.hand.length} card${p.hand.length !== 1 ? "s" : ""}`}`).join("\n");

  console.log("[game] broadcasting game end", { roomId: g.room_id, durakName });

  for (const p of g.players) {
    if (p.status === "left") continue;
    try {
      await ctx.api.sendMessage(p.user_id, text);
    } catch {
      // blocked
    }
  }
}

// ---- /hand command ----

composer.command("hand", async (ctx) => {
  const uid = ctx.from!.id;
  const rid = await getUserRoom(uid);
  if (!rid) {
    await ctx.reply("You're not in a room right now — create or join one from /start.");
    return;
  }
  const room = await readRoom(rid);
  if (!room?.game) {
    await ctx.reply("No game in progress — wait for the host to start.");
    return;
  }
  const player = room.game.players.find((p) => p.user_id === uid);
  if (!player || player.status === "left") {
    await ctx.reply("You're not in this game.");
    return;
  }
  await sendPrivateHand(ctx, room.game, player, rid);
});

// ---- turn expiry sweeper ----

composer.use(async (ctx, next) => {
  const uid = ctx.from?.id;
  if (!uid) return next();

  const rid = await getUserRoom(uid);
  if (!rid) return next();

  const room = await readRoom(rid);
  if (!room?.game || room.game.phase === "ended") return next();

  const g = room.game;
  if (now() > g.turn_deadline) {
    await handleTurnTimeout(ctx, g, rid, room);
    return;
  }

  return next();
});

async function handleTurnTimeout(
  ctx: Ctx,
  g: StoredGameState,
  rid: string,
  room: StoredRoom,
): Promise<void> {
  const upTo = initialHandSize(room);

  if (g.phase === "attack") {
    if (g.table.length > 0) {
      const defender = g.players[g.defender_idx];
      for (const pair of g.table) {
        defender.hand.push(pair.attack);
        if (pair.defend) defender.hand.push(pair.defend);
      }
      g.table = [];
    }
    for (const p of g.players) {
      if (isPlayerActive(p)) refillHand(g, p, upTo);
    }
    if (checkGameEnd(g)) {
      await saveRoom(room);
      await broadcastGameEnd(ctx, g);
      return;
    }
    nextAttackerDefender(g);
    g.phase = "attack";
    g.turn_deadline = now() + TURN_TIMEOUT_MS;
    await saveRoom(room);
    await broadcastPublicState(ctx, g);
    for (const p of g.players) {
      if (isPlayerActive(p)) await sendPrivateHand(ctx, g, p, rid);
    }
    try { await ctx.api.sendMessage(g.players[g.attacker_idx].user_id, "⏰ Turn timed out — auto-passed to next player."); } catch {}
  } else if (g.phase === "defend") {
    const defender = g.players[g.defender_idx];
    for (const pair of g.table) {
      defender.hand.push(pair.attack);
      if (pair.defend) defender.hand.push(pair.defend);
    }
    g.table = [];
    for (const p of g.players) {
      if (isPlayerActive(p)) refillHand(g, p, upTo);
    }
    if (checkGameEnd(g)) {
      await saveRoom(room);
      await broadcastGameEnd(ctx, g);
      return;
    }
    g.phase = "attack";
    g.turn_deadline = now() + TURN_TIMEOUT_MS;
    await saveRoom(room);
    await broadcastPublicState(ctx, g);
    for (const p of g.players) {
      if (isPlayerActive(p)) await sendPrivateHand(ctx, g, p, rid);
    }
    try { await ctx.api.sendMessage(defender.user_id, "⏰ Time's up — you took all the cards."); } catch {}
  } else if (g.phase === "podkid") {
    const allDefended = g.table.every((p) => p.defend);
    if (allDefended) {
      for (const pair of g.table) {
        g.discard.push(pair.attack);
        if (pair.defend) g.discard.push(pair.defend);
      }
      g.table = [];
    } else {
      const defender = g.players[g.defender_idx];
      for (const pair of g.table) {
        defender.hand.push(pair.attack);
        if (pair.defend) defender.hand.push(pair.defend);
      }
      g.table = [];
    }
    await advanceTurn(ctx, g, rid, room);
  }
}

export default composer;
