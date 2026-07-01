import { Composer, type Api } from "grammy";
import type { Ctx } from "../bot.js";
import {
  readRoom,
  saveRoom,
  updateRoom,
  deleteRoom,
  getUserRoom,
  type StoredGameState,
  type StoredPlayer,
  type StoredCard,
  type StoredRoom,
} from "../lib/storage.js";
import { cardBeats, cardToString, tableRanks } from "../lib/cards.js";
import { now, TURN_TIMEOUT_MS, scheduleGameTimer, clearGameTimer } from "../lib/clock.js";
import {
  sendPrivateHandApi,
  broadcastPublicStateApi,
  broadcastGameEndApi,
  formatPlayerListLobby,
} from "../lib/messages.js";

const composer = new Composer<Ctx>();

// ---- helpers ----

/** Thrown inside updateRoom's mutate callback to signal a non-retryable
 *  validation failure (e.g. wrong player, wrong phase). The caller catches
 *  it and shows the message to the actor. */
class GameActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameActionError";
  }
  static is(err: unknown): err is GameActionError {
    return err instanceof GameActionError;
  }
}

function initialHandSize(room: StoredRoom): number {
  return room.initial_hand_size;
}

function drawCards(game: StoredGameState, count: number): StoredCard[] {
  const drawn: StoredCard[] = [];
  while (count > 0 && game.deck.length > 0) {
    drawn.push(game.deck.shift()!);
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

  // Bump turn id each time the active pair rotates — used for timeout audit logging.
  game.turn_id = (game.turn_id ?? 0) + 1;
}

function checkGameEnd(g: StoredGameState): boolean {
  // A player who empties their hand when the deck is exhausted has finished
  // — they are NOT the дурак (loser). Only the last player holding cards loses.
  for (const p of g.players) {
    if (p.status === "playing" && p.hand.length === 0 && g.deck.length === 0) {
      p.status = "out";
    }
  }
  const playingNow = g.players.filter((p) => p.status === "playing");
  if (playingNow.length < 2) {
    // The last player still "playing" is the дурак (loser)
    if (playingNow.length === 1) {
      playingNow[0].status = "durak";
    }
    // also mark any "out" players who haven't been formally designated
    for (const p of g.players) {
      if (p.status === "playing" && p.hand.length === 0) {
        p.status = "out";
      }
    }
    g.phase = "ended";
    return true;
  }
  return false;
}

function isPlayerActive(p: StoredPlayer): boolean {
  return p.status === "playing";
}

// ---- defensive helpers ----

async function loadRoomGame(
  ctx: Ctx,
  rid: string,
): Promise<StoredRoom | null> {
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
  return room;
}

async function checkTurnDeadline(
  ctx: Ctx,
  g: StoredGameState,
  rid: string,
  room: StoredRoom,
): Promise<boolean> {
  if (now() > g.turn_deadline) {
    console.warn("[game] turn expired on handler entry", { rid, phase: g.phase });
    try { await ctx.reply("⏰ This turn's timed out — the game moved on."); } catch {}
    await handleTurnTimeout(ctx.api, g, rid, room);
    return false;
  }
  return true;
}

function validateCardIndex(
  ctx: Ctx,
  player: StoredPlayer,
  idx: number,
): boolean {
  if (!player.hand[idx]) {
    console.warn("[game] card index out of bounds", {
      userId: player.user_id, idx, handSize: player.hand.length,
    });
    try {
      ctx.answerCallbackQuery({ text: "That card isn't in your hand.", show_alert: false });
    } catch {}
    return false;
  }
  return true;
}

// ---- timer scheduling ----

function scheduleTurnTimer(api: Api, rid: string, deadline: number): void {
  const delay = Math.max(1000, deadline - now());
  scheduleGameTimer(rid, async () => {
    const room = await readRoom(rid);
    if (!room?.game || room.game.phase === "ended") return;
    if (now() >= room.game.turn_deadline) {
      console.log("[game] proactive timer fired", { rid, phase: room.game.phase });
      await handleTurnTimeout(api, room.game, rid, room);
    }
  }, delay);
}

// ---- attack:card callback ----

composer.callbackQuery(/^atk:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const idx = parseInt(ctx.match![2], 10);
  const uid = ctx.from!.id;

  console.log("[game] attack:card", { rid, idx, uid });

  const room = await loadRoomGame(ctx, rid);
  if (!room) return;
  const g = room.game!;

  if (!(await checkTurnDeadline(ctx, g, rid, room))) return;

  const attacker = g.players[g.attacker_idx];
  if (!attacker) {
    console.error("[game] invalid attacker_idx", { rid, attacker_idx: g.attacker_idx });
    await ctx.reply("Something's wrong with the game state — ask the host to restart.");
    return;
  }

  if (attacker.user_id !== uid) {
    console.warn("[game] non-attacker tapped attack card", {
      rid, uid, attackerId: attacker.user_id, phase: g.phase,
    });
    if (g.phase === "podkid" && g.players[g.defender_idx]?.user_id !== uid) {
      return handlePodkid(ctx, g, rid, uid, idx);
    }
    await ctx.answerCallbackQuery({ text: "Not your turn to attack.", show_alert: true });
    return;
  }

  if (g.phase !== "attack") {
    await ctx.reply("Not the attack phase right now.");
    return;
  }

  if (!validateCardIndex(ctx, attacker, idx)) return;

  // Multi-card attack: if table has cards, must match existing rank
  if (g.table.length > 0) {
    const ranks = tableRanks(g.table);
    if (!ranks.has(attacker.hand[idx].rank)) {
      await ctx.reply("You can only play a card matching a rank already on the table.");
      return;
    }
  }

  // Cap attacks at the defender's current hand size (max 6).
  // Standard Durak rule: you cannot attack with more cards
  // than the defender can hold.
  const defender = g.players[g.defender_idx];
  const maxAttacks = Math.min(6, defender ? defender.hand.length : 6);
  if (g.table.length >= maxAttacks) {
    if (maxAttacks <= 0) {
      await ctx.reply("The defender has no cards — tap ✅ Done attacking.");
    } else {
      await ctx.reply(`Max ${maxAttacks} attack${maxAttacks !== 1 ? "s" : ""} on the table — tap ✅ Done attacking.`);
    }
    return;
  }

  const card = attacker.hand[idx];
  const deadline = now() + TURN_TIMEOUT_MS;

  console.log("[game] attack played", {
    rid, uid, card: cardToString(card), tableSize: g.table.length + 1,
  });

  let updatedRoom: StoredRoom;
  try {
    updatedRoom = await updateRoom(rid, (fresh) => {
      const fg = fresh.game;
      if (!fg || fg.phase === "ended") throw new GameActionError("Game already ended.");
      if (fg.phase !== "attack") throw new GameActionError("Phase changed — not attack anymore.");
      const fa = fg.players[fg.attacker_idx];
      if (!fa || fa.user_id !== uid) throw new GameActionError("You're no longer the attacker.");

      // Re-check card index under lock
      if (!fa.hand[idx]) throw new GameActionError("Card isn't in your hand anymore.");
      if (fg.table.length > 0 && !tableRanks(fg.table).has(fa.hand[idx].rank)) {
        throw new GameActionError("That rank can't be played anymore.");
      }
      if (fg.table.length >= Math.min(6, fg.players[fg.defender_idx]?.hand.length ?? 6)) throw new GameActionError("Table is full.");

      const played = fa.hand.splice(idx, 1)[0];
      fg.table.push({ attack: played });
      fg.turn_deadline = deadline;
      fg.timeout_resolved = false;
    });
  } catch (err) {
    if (GameActionError.is(err)) {
      await ctx.reply(err.message);
      return;
    }
    throw err;
  }

  const ug = updatedRoom.game!;
  scheduleTurnTimer(ctx.api, rid, ug.turn_deadline);
  await broadcastPublicStateApi(ctx.api, ug);
  await sendPrivateHandApi(ctx.api, ug, ug.players[ug.attacker_idx], rid);
  await sendPrivateHandApi(ctx.api, ug, ug.players[ug.defender_idx], rid);
});

// ---- defend:card callback ----

composer.callbackQuery(/^def:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const idx = parseInt(ctx.match![2], 10);
  const uid = ctx.from!.id;

  console.log("[game] defend:card", { rid, idx, uid });

  const room = await loadRoomGame(ctx, rid);
  if (!room) return;
  const g = room.game!;

  if (!(await checkTurnDeadline(ctx, g, rid, room))) return;

  const defender = g.players[g.defender_idx];
  if (!defender) {
    console.error("[game] invalid defender_idx", { rid, defender_idx: g.defender_idx });
    await ctx.reply("Something's wrong with the game state — ask the host to restart.");
    return;
  }

  if (defender.user_id !== uid) {
    console.warn("[game] non-defender tapped defend card", {
      rid, uid, defenderId: defender.user_id, phase: g.phase,
    });
    await ctx.answerCallbackQuery({ text: "Not your turn to defend.", show_alert: true });
    return;
  }

  if (g.phase !== "defend") {
    await ctx.reply("Not the defend phase right now.");
    return;
  }

  if (!validateCardIndex(ctx, defender, idx)) return;

  const undefendedIdx = g.table.findIndex((p) => !p.defend);
  if (undefendedIdx === -1) {
    await ctx.reply("All attacks are covered — tap Done or toss in more cards.");
    return;
  }

  const attack = g.table[undefendedIdx].attack;
  const defendCard = defender.hand[idx];

  if (!cardBeats(attack, defendCard, g.trump_suit)) {
    const hint =
      attack.suit === g.trump_suit
        ? `Pick a higher trump to beat ${cardToString(attack)}.`
        : `Pick a higher rank of the same suit (${attack.suit}) or any trump.`;
    await ctx.reply(
      `${cardToString(defendCard)} can't beat ${cardToString(attack)}. ${hint}`,
    );
    return;
  }

  console.log("[game] defended", {
    rid, uid, defendCard: cardToString(defendCard), vs: cardToString(attack),
  });

  const newDeadline = now() + TURN_TIMEOUT_MS;
  let updatedRoom: StoredRoom;
  let allDefended = false;
  try {
    updatedRoom = await updateRoom(rid, (fresh) => {
      const fg = fresh.game;
      if (!fg || fg.phase === "ended") throw new GameActionError("Game already ended.");
      if (fg.phase !== "defend") throw new GameActionError("Phase changed — not defend anymore.");
      const fd = fg.players[fg.defender_idx];
      if (!fd || fd.user_id !== uid) throw new GameActionError("You're no longer the defender.");
      if (!fd.hand[idx]) throw new GameActionError("Card isn't in your hand anymore.");

      const uIdx = fg.table.findIndex((p) => !p.defend);
      if (uIdx === -1) throw new GameActionError("All attacks are already covered.");

      const atk = fg.table[uIdx].attack;
      if (!cardBeats(atk, fd.hand[idx], fg.trump_suit)) {
        throw new GameActionError("That card can't beat the attack anymore.");
      }

      const dc = fd.hand.splice(idx, 1)[0];
      fg.table[uIdx].defend = dc;

      allDefended = fg.table.every((p) => p.defend);
      if (allDefended) {
        fg.phase = "podkid";
        fg.turn_deadline = newDeadline;
        fg.timeout_resolved = false;
      }
    });
  } catch (err) {
    if (GameActionError.is(err)) {
      await ctx.reply(err.message);
      return;
    }
    throw err;
  }

  const ug = updatedRoom.game!;
  if (allDefended) scheduleTurnTimer(ctx.api, rid, ug.turn_deadline);
  await broadcastPublicStateApi(ctx.api, ug);
  await sendPrivateHandApi(ctx.api, ug, ug.players[ug.defender_idx], rid);

  if (allDefended) {
    for (const p of ug.players) {
      if (p.status === "playing" && p.user_id !== ug.players[ug.defender_idx]?.user_id) {
        await sendPrivateHandApi(ctx.api, ug, p, rid);
      }
    }
  }
});

// ---- podkid helper ----

async function handlePodkid(
  ctx: Ctx,
  g: StoredGameState,
  rid: string,
  uid: number,
  idx: number,
): Promise<void> {
  const player = g.players.find((p) => p.user_id === uid);
  if (!player || player.status !== "playing") {
    console.warn("[game] podkid by non-playing user", { rid, uid });
    await ctx.answerCallbackQuery({ text: "You're not playing in this game.", show_alert: true });
    return;
  }

  if (!player.hand[idx]) {
    console.warn("[game] podkid card index out of bounds", { rid, uid, idx, handSize: player.hand.length });
    await ctx.answerCallbackQuery({ text: "That card isn't in your hand.", show_alert: false });
    return;
  }

  const ranks = tableRanks(g.table);
  if (!ranks.has(player.hand[idx].rank)) {
    await ctx.answerCallbackQuery({ text: "You can only toss in a card matching a rank already on the table.", show_alert: true });
    return;
  }

  if (g.table.length >= 6) {
    await ctx.answerCallbackQuery({ text: "Max attacks on the table already — tap Done.", show_alert: true });
    return;
  }

  const card = player.hand[idx];
  const deadline = now() + TURN_TIMEOUT_MS;

  console.log("[game] podkid card", {
    rid, uid, card: cardToString(card), tableSize: g.table.length + 1,
  });

  let updatedRoom: StoredRoom;
  try {
    updatedRoom = await updateRoom(rid, (fresh) => {
      const fg = fresh.game;
      if (!fg || fg.phase === "ended") throw new GameActionError("Game already ended.");
      if (fg.phase !== "podkid") throw new GameActionError("Not the podkid phase anymore.");
      const fp = fg.players.find((p) => p.user_id === uid);
      if (!fp || fp.status !== "playing") throw new GameActionError("You're no longer playing.");
      if (fg.players[fg.defender_idx]?.user_id === uid) {
        throw new GameActionError("Defender can't toss in cards.");
      }
      if (!fp.hand[idx]) throw new GameActionError("Card isn't in your hand anymore.");
      if (!tableRanks(fg.table).has(fp.hand[idx].rank)) {
        throw new GameActionError("That rank can't be tossed in anymore.");
      }
      if (fg.table.length >= Math.min(6, fg.players[fg.defender_idx]?.hand.length ?? 6)) throw new GameActionError("Table is full.");

      const pc = fp.hand.splice(idx, 1)[0];
      fg.table.push({ attack: pc });
      fg.turn_deadline = deadline;
      fg.timeout_resolved = false;
    });
  } catch (err) {
    if (GameActionError.is(err)) {
      await ctx.reply(err.message);
      return;
    }
    throw err;
  }

  const ug = updatedRoom.game!;
  scheduleTurnTimer(ctx.api, rid, ug.turn_deadline);
  await broadcastPublicStateApi(ctx.api, ug);
  const podPlayer = ug.players.find((p) => p.user_id === uid)!;
  await sendPrivateHandApi(ctx.api, ug, podPlayer, rid);
  await sendPrivateHandApi(ctx.api, ug, ug.players[ug.defender_idx], rid);
}

// ---- podkid:card callback ----

composer.callbackQuery(/^pod:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const idx = parseInt(ctx.match![2], 10);
  const uid = ctx.from!.id;

  console.log("[game] podkid:card", { rid, idx, uid });

  const room = await loadRoomGame(ctx, rid);
  if (!room) return;
  const g = room.game!;

  if (!(await checkTurnDeadline(ctx, g, rid, room))) return;

  const defender = g.players[g.defender_idx];
  if (!defender) {
    console.error("[game] invalid defender_idx in podkid", { rid });
    await ctx.reply("Something's wrong with the game state.");
    return;
  }

  if (g.phase !== "podkid") {
    await ctx.reply("Not the podkid phase right now.");
    return;
  }

  if (defender.user_id === uid) {
    await ctx.reply("Defender can't toss cards in — only defend or take.");
    return;
  }

  return handlePodkid(ctx, g, rid, uid, idx);
});

// ---- take action ----

composer.callbackQuery(/^take:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const uid = ctx.from!.id;

  console.log("[game] take", { rid, uid });

  const room = await loadRoomGame(ctx, rid);
  if (!room) return;
  const g = room.game!;

  const defender = g.players[g.defender_idx];
  if (!defender) {
    console.error("[game] invalid defender_idx in take", { rid });
    await ctx.reply("Something's wrong with the game state.");
    return;
  }

  if (defender.user_id !== uid) {
    console.warn("[game] non-defender tried to take", { rid, uid, defenderId: defender.user_id });
    await ctx.answerCallbackQuery({ text: "Only the defender can take cards.", show_alert: true });
    return;
  }

  if (g.phase !== "defend" && g.phase !== "podkid") {
    await ctx.reply("Not the right phase to take cards.");
    return;
  }

  const upTo = initialHandSize(room);
  const deadline = now() + TURN_TIMEOUT_MS;
  let updatedRoom: StoredRoom;
  try {
    updatedRoom = await updateRoom(rid, (fresh) => {
      const fg = fresh.game;
      if (!fg || fg.phase === "ended") throw new GameActionError("Game already ended.");
      if (fg.phase !== "defend" && fg.phase !== "podkid") {
        throw new GameActionError("Phase changed — can't take now.");
      }
      const fd = fg.players[fg.defender_idx];
      if (!fd || fd.user_id !== uid) throw new GameActionError("You're no longer the defender.");

      for (const pair of fg.table) {
        fd.hand.push(pair.attack);
        if (pair.defend) fd.hand.push(pair.defend);
      }
      fg.table = [];

      // Refill other active players — defender doesn't draw
      for (const p of fg.players) {
        if (p.user_id !== uid && isPlayerActive(p)) {
          const needed = Math.max(0, upTo - p.hand.length);
          if (needed > 0) {
            const drawn = drawCards(fg, needed);
            p.hand.push(...drawn);
          }
        }
      }

      fg.phase = "attack";
      fg.turn_deadline = deadline;
      fg.timeout_resolved = false;
    });
  } catch (err) {
    if (GameActionError.is(err)) {
      await ctx.reply(err.message);
      return;
    }
    throw err;
  }

  const ug = updatedRoom.game!;
  scheduleTurnTimer(ctx.api, rid, ug.turn_deadline);
  await broadcastPublicStateApi(ctx.api, ug);
  await sendPrivateHandApi(ctx.api, ug, ug.players[ug.defender_idx], rid);
  for (const p of ug.players) {
    if (p.user_id !== ug.players[ug.defender_idx]?.user_id && isPlayerActive(p)) {
      await sendPrivateHandApi(ctx.api, ug, p, rid);
    }
  }
});

// ---- done action ----

composer.callbackQuery(/^done:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const uid = ctx.from!.id;

  console.log("[game] done", { rid, uid });

  const room = await loadRoomGame(ctx, rid);
  if (!room) return;
  const g = room.game!;

  if (g.phase === "attack") {
    if (g.table.length === 0) {
      await ctx.reply("You have to play at least one card first.");
      return;
    }
    const attacker = g.players[g.attacker_idx];
    if (!attacker || attacker.user_id !== uid) {
      console.warn("[game] non-attacker tried done in attack phase", {
        rid, uid, attackerId: attacker?.user_id,
      });
      await ctx.answerCallbackQuery({ text: "Only the current attacker can finish.", show_alert: true });
      return;
    }

    const deadline = now() + TURN_TIMEOUT_MS;
    let updatedRoom: StoredRoom;
    try {
      updatedRoom = await updateRoom(rid, (fresh) => {
        const fg = fresh.game;
        if (!fg || fg.phase === "ended") throw new GameActionError("Game already ended.");
        if (fg.phase !== "attack") throw new GameActionError("Not the attack phase anymore.");
        const fa = fg.players[fg.attacker_idx];
        if (!fa || fa.user_id !== uid) throw new GameActionError("You're no longer the attacker.");
        if (fg.table.length === 0) throw new GameActionError("Must attack with at least one card.");
        fg.phase = "defend";
        fg.turn_deadline = deadline;
        fg.timeout_resolved = false;
      });
    } catch (err) {
      if (GameActionError.is(err)) {
        await ctx.reply(err.message);
        return;
      }
      throw err;
    }

    const ug = updatedRoom.game!;
    console.log("[game] attacker done → defend phase", { rid, tableSize: ug.table.length });
    scheduleTurnTimer(ctx.api, rid, ug.turn_deadline);
    await broadcastPublicStateApi(ctx.api, ug);
    await sendPrivateHandApi(ctx.api, ug, ug.players[ug.defender_idx], rid);
    for (const p of ug.players) {
      if (p.user_id !== ug.players[ug.defender_idx]?.user_id && isPlayerActive(p)) {
        await sendPrivateHandApi(ctx.api, ug, p, rid);
      }
    }
    return;
  }

  if (g.phase === "podkid") {
    const defender = g.players[g.defender_idx];
    const caller = g.players.find((p) => p.user_id === uid);
    if (!caller || caller.status !== "playing") {
      await ctx.answerCallbackQuery({ text: "You're not in this game.", show_alert: true });
      return;
    }
    if (defender && defender.user_id === uid) {
      console.warn("[game] defender tried done in podkid phase", { rid, uid });
      await ctx.answerCallbackQuery({ text: "Only tossers can finish — you're defending!", show_alert: true });
      return;
    }

    const allDefended = g.table.every((p) => p.defend);
    if (!allDefended) {
      await ctx.reply("Wait — some attacks are still undefended.");
      return;
    }

    console.log("[game] done in podkid phase → advance turn", { rid, uid });
    return advanceTurn(ctx.api, rid, room);
  }

  await ctx.reply("Nothing to finish right now.");
});

// ---- advance turn (used by done:podkid, podkid timeout, and defend timeout) ----

async function advanceTurn(
  api: Api,
  rid: string,
  room: StoredRoom,
): Promise<void> {
  clearGameTimer(rid);
  const upTo = initialHandSize(room);
  const deadline = now() + TURN_TIMEOUT_MS;

  let updatedRoom: StoredRoom;
  try {
    updatedRoom = await updateRoom(rid, (fresh) => {
      const fg = fresh.game;
      if (!fg || fg.phase === "ended") throw new GameActionError("Game already ended.");

      // Discard all table cards
      for (const pair of fg.table) {
        fg.discard.push(pair.attack);
        if (pair.defend) fg.discard.push(pair.defend);
      }
      fg.table = [];

      // Refill starting from attacker
      const startIdx = fg.attacker_idx;
      for (let i = 0; i < fg.players.length; i++) {
        const p = fg.players[(startIdx + i) % fg.players.length];
        if (isPlayerActive(p)) {
          const needed = Math.max(0, upTo - p.hand.length);
          if (needed > 0) {
            const drawn = drawCards(fg, needed);
            p.hand.push(...drawn);
          }
        }
      }

      // Mark empty-hand players as "out" when deck is exhausted
      if (fg.deck.length === 0) {
        for (const p of fg.players) {
          if (isPlayerActive(p) && p.hand.length === 0) {
            p.status = "out";
          }
        }
      }

      if (checkGameEnd(fg)) {
        return;
      }

      nextAttackerDefender(fg);
      fg.phase = "attack";
      fg.turn_deadline = deadline;
      fg.timeout_resolved = false;
    });
  } catch (err) {
    if (GameActionError.is(err)) {
      return; // game ended or disappeared
    }
    throw err;
  }

  const ug = updatedRoom.game!;
  if (ug.phase === "ended") {
    console.log("[game] game ended via advanceTurn", { rid });
    await broadcastGameEndApi(api, ug);
    return;
  }

  console.log("[game] turn advanced", { rid, newAttacker: ug.players[ug.attacker_idx]?.telegram_name });

  scheduleTurnTimer(api, rid, ug.turn_deadline);
  await broadcastPublicStateApi(api, ug);

  for (const p of ug.players) {
    if (isPlayerActive(p)) {
      await sendPrivateHandApi(api, ug, p, rid);
    }
  }
}

// ---- handleTurnTimeout (proactive + reactive) ----

async function handleTurnTimeout(
  api: Api,
  g: StoredGameState,
  rid: string,
  room: StoredRoom,
): Promise<void> {
  // ---- ATOMIC GATE: claim the timeout slot for this turn ----
  // Mutiple sources (reactive sweep + proactive timer) can race to
  // handle the same expired turn. The first caller to atomically set
  // `timeout_resolved` claims it; all others bail immediately.
  const timedOutTurnId = g.turn_id;
  const timedOutPhase = g.phase;
  const timedOutUserId =
    timedOutPhase === "defend" || timedOutPhase === "podkid"
      ? g.players[g.defender_idx]?.user_id
      : g.players[g.attacker_idx]?.user_id;

  let claimed = false;
  try {
    await updateRoom(rid, (fresh) => {
      const fg = fresh.game;
      if (!fg || fg.phase === "ended") throw new GameActionError("Game ended.");
      // Guard: another caller already resolved this timeout.
      if (fg.timeout_resolved) throw new GameActionError("already-resolved");
      fg.timeout_resolved = true;
      claimed = true;
    });
  } catch (err) {
    if (GameActionError.is(err) && err.message === "already-resolved") {
      console.log("[game] timeout already resolved — bailing", { rid, turnId: timedOutTurnId });
      return;
    }
    if (GameActionError.is(err)) return; // game ended or gone
    throw err;
  }

  if (!claimed) return;

  clearGameTimer(rid);

  // ---- AUDIT LOG ----
  console.log("[game] turn timeout fired", {
    rid,
    playerId: timedOutUserId,
    turnId: timedOutTurnId,
    phase: timedOutPhase,
    timestamp: now(),
  });

  // ---- NOTIFICATION: room + offending player ----
  const playerName = timedOutUserId
    ? g.players.find((p) => p.user_id === timedOutUserId)?.telegram_name
    : "Someone";
  const phaseLabel = timedOutPhase === "attack" ? "attack" : timedOutPhase === "defend" ? "defend" : "podkid";
  const notifText = `⏰ ${playerName}'s ${phaseLabel} phase timed out — the game moved on.`;

  for (const p of g.players) {
    if (p.status === "left" || p.status === "durak" || p.status === "out") continue;
    try {
      await api.sendMessage(p.user_id, notifText);
    } catch {}
  }
  if (timedOutUserId) {
    try {
      await api.sendMessage(timedOutUserId, "⏰ Your turn timed out.");
    } catch {}
  }

  const upTo = initialHandSize(room);

  if (g.phase === "attack") {
    if (g.table.length > 0) {
      // Attacker timed out with cards on table → transition to defend phase
      // (mirrors what happens when attacker presses "✅ Done attacking"),
      // giving the defender a fair chance to defend.
      const deadline = now() + TURN_TIMEOUT_MS;
      let updatedRoom: StoredRoom;
      try {
        updatedRoom = await updateRoom(rid, (fresh) => {
          const fg = fresh.game;
          if (!fg || fg.phase === "ended") throw new GameActionError("Game ended.");
          if (fg.phase !== "attack") throw new GameActionError("Phase changed.");
          fg.phase = "defend";
          fg.turn_deadline = deadline;
          fg.timeout_resolved = false;
        });
      } catch (err) {
        if (GameActionError.is(err)) return;
        throw err;
      }

      const ug = updatedRoom.game!;
      scheduleTurnTimer(api, rid, ug.turn_deadline);
      await broadcastPublicStateApi(api, ug);
      await sendPrivateHandApi(api, ug, ug.players[ug.defender_idx], rid);
      for (const p of ug.players) {
        if (p.user_id !== ug.players[ug.defender_idx]?.user_id && isPlayerActive(p)) {
          await sendPrivateHandApi(api, ug, p, rid);
        }
      }
    } else {
      // Attacker timed out without playing any cards → skip their turn
      const deadline = now() + TURN_TIMEOUT_MS;
      let updatedRoom: StoredRoom;
      try {
        updatedRoom = await updateRoom(rid, (fresh) => {
          const fg = fresh.game;
          if (!fg || fg.phase === "ended") throw new GameActionError("Game ended.");
          if (fg.phase !== "attack") throw new GameActionError("Phase changed.");
          nextAttackerDefender(fg);
          fg.phase = "attack";
          fg.turn_deadline = deadline;
          fg.timeout_resolved = false;
        });
      } catch (err) {
        if (GameActionError.is(err)) return;
        throw err;
      }

      const ug = updatedRoom.game!;
      scheduleTurnTimer(api, rid, ug.turn_deadline);
      await broadcastPublicStateApi(api, ug);
      for (const p of ug.players) {
        if (isPlayerActive(p)) await sendPrivateHandApi(api, ug, p, rid);
      }
    }
  } else if (g.phase === "defend") {
    // Defender timed out → take all cards
    const deadline = now() + TURN_TIMEOUT_MS;
    let updatedRoom: StoredRoom;
    try {
      updatedRoom = await updateRoom(rid, (fresh) => {
        const fg = fresh.game;
        if (!fg || fg.phase === "ended") throw new GameActionError("Game ended.");
        if (fg.phase !== "defend") throw new GameActionError("Phase changed.");
        const fd = fg.players[fg.defender_idx];
        if (fd) {
          for (const pair of fg.table) {
            fd.hand.push(pair.attack);
            if (pair.defend) fd.hand.push(pair.defend);
          }
        }
        fg.table = [];
        for (const p of fg.players) {
          if (isPlayerActive(p)) {
            const needed = Math.max(0, upTo - p.hand.length);
            if (needed > 0) {
              const drawn = drawCards(fg, needed);
              p.hand.push(...drawn);
            }
          }
        }
        if (checkGameEnd(fg)) return;
        nextAttackerDefender(fg);
        fg.phase = "attack";
        fg.turn_deadline = deadline;
        fg.timeout_resolved = false;
      });
    } catch (err) {
      if (GameActionError.is(err)) return;
      throw err;
    }

    const ug = updatedRoom.game!;
    if (ug.phase === "ended") {
      await broadcastGameEndApi(api, ug);
      return;
    }
    scheduleTurnTimer(api, rid, ug.turn_deadline);
    await broadcastPublicStateApi(api, ug);
    for (const p of ug.players) {
      if (isPlayerActive(p)) await sendPrivateHandApi(api, ug, p, rid);
    }
  } else if (g.phase === "podkid") {
    // Podkid timed out → if all defended, discard; else defender takes
    let gameEnded = false;
    let updatedRoom: StoredRoom | null = null;
    try {
      updatedRoom = await updateRoom(rid, (fresh) => {
        const fg = fresh.game;
        if (!fg || fg.phase === "ended") throw new GameActionError("Game ended.");
        if (fg.phase !== "podkid") throw new GameActionError("Phase changed.");

        const allDefended = fg.table.every((p) => p.defend);
        if (allDefended) {
          for (const pair of fg.table) {
            fg.discard.push(pair.attack);
            if (pair.defend) fg.discard.push(pair.defend);
          }
          fg.table = [];
        } else {
          const fd = fg.players[fg.defender_idx];
          if (fd) {
            for (const pair of fg.table) {
              fd.hand.push(pair.attack);
              if (pair.defend) fd.hand.push(pair.defend);
            }
          }
          fg.table = [];
        }

        // Refill + check end + advance
        for (const p of fg.players) {
          if (isPlayerActive(p)) {
            const needed = Math.max(0, upTo - p.hand.length);
            if (needed > 0) {
              const drawn = drawCards(fg, needed);
              p.hand.push(...drawn);
            }
          }
        }
        if (fg.deck.length === 0) {
          for (const p of fg.players) {
            if (isPlayerActive(p) && p.hand.length === 0) p.status = "out";
          }
        }
        if (checkGameEnd(fg)) { gameEnded = true; return; }
        nextAttackerDefender(fg);
        fg.phase = "attack";
        fg.turn_deadline = now() + TURN_TIMEOUT_MS;
        fg.timeout_resolved = false;
      });
    } catch (err) {
      if (GameActionError.is(err)) return;
      throw err;
    }

    if (!updatedRoom) return;

    const ug = updatedRoom.game!;
    if (gameEnded || ug.phase === "ended") {
      await broadcastGameEndApi(api, ug);
      return;
    }
    scheduleTurnTimer(api, rid, ug.turn_deadline);
    await broadcastPublicStateApi(api, ug);
    for (const p of ug.players) {
      if (isPlayerActive(p)) await sendPrivateHandApi(api, ug, p, rid);
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
  await sendPrivateHandApi(ctx.api, room.game, player, rid);
});

// ---- /leave command + leave:room callback ----

composer.command("leave", async (ctx) => {
  const uid = ctx.from!.id;
  const rid = await getUserRoom(uid);
  if (!rid) {
    await ctx.reply("You're not in a room right now.");
    return;
  }
  await handleLeaveRoom(ctx, rid, uid);
});

composer.callbackQuery(/^leave:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const uid = ctx.from!.id;
  await handleLeaveRoom(ctx, rid, uid);
});

async function handleLeaveRoom(ctx: Ctx, rid: string, uid: number): Promise<void> {
  const room = await readRoom(rid);
  if (!room) {
    await ctx.reply("Room not found — it may have been closed.");
    return;
  }

  const player = room.players.find((p) => p.user_id === uid);
  if (!player || player.status === "left") {
    await ctx.reply("You're not in this room.");
    return;
  }

  if (room.game && room.game.phase !== "ended") {
    // Mid-game leave — mark player as left but game continues
    const g = room.game;
    const isAttacker = g.players[g.attacker_idx]?.user_id === uid;
    const isDefender = g.players[g.defender_idx]?.user_id === uid;

    try {
      await updateRoom(rid, (fresh) => {
        const pl = fresh.players.find((p) => p.user_id === uid);
        if (pl) pl.status = "left";

        if (fresh.game && fresh.game.phase !== "ended") {
          const gp = fresh.game.players.find((p) => p.user_id === uid);
          if (gp) gp.status = "left";
        }
      });
    } catch {
      // room gone — already handled
    }

    // Handle turn rotation if leaver was active player
    if (isAttacker && g.phase === "attack") {
      if (g.table.length > 0) {
        // Cards on table → transition to defend for fairness
        await handleTurnTimeout(ctx.api, g, rid, room);
      } else {
        // No cards → skip attacker, move to next
        let updatedRoom: StoredRoom;
        try {
          updatedRoom = await updateRoom(rid, (fresh) => {
            const fg = fresh.game;
            if (!fg || fg.phase === "ended") throw new GameActionError("Game ended.");
            nextAttackerDefender(fg);
            fg.phase = "attack";
            fg.turn_deadline = now() + TURN_TIMEOUT_MS;
            fg.timeout_resolved = false;
          });
        } catch (err) {
          if (GameActionError.is(err)) return;
          throw err;
        }

        const ug = updatedRoom.game!;
        scheduleTurnTimer(ctx.api, rid, ug.turn_deadline);
        await broadcastPublicStateApi(ctx.api, ug);
        for (const p of ug.players) {
          if (isPlayerActive(p)) await sendPrivateHandApi(ctx.api, ug, p, rid);
        }
      }
    } else if (isDefender && (g.phase === "defend" || g.phase === "podkid")) {
      await handleTurnTimeout(ctx.api, g, rid, room);
    } else {
      await broadcastPublicStateApi(ctx.api, g);
    }
    await ctx.reply("You've left the game. 👋");
  } else {
    // Lobby leave — use updateRoom for atomicity
    const playerName = player.telegram_name;
    try {
      await updateRoom(rid, (r) => {
        r.players = r.players.filter((p) => p.user_id !== uid);
        if (r.players.length > 0 && r.host_id === uid) {
          r.host_id = r.players[0].user_id;
        }
      });
    } catch {
      // room already deleted or gone
    }

    const updatedRoom = await readRoom(rid);
    if (!updatedRoom || updatedRoom.players.length === 0) {
      await deleteRoom(rid);
    } else {
      const msg =
        `🚪 ${playerName} left the room.\n\n` +
        formatPlayerListLobby(updatedRoom.players, updatedRoom.max_players);
      for (const p of updatedRoom.players) {
        try { await ctx.api.sendMessage(p.user_id, msg); } catch {}
      }
    }
    await ctx.reply("You've left the room. 👋");
  }
}

// ---- game:end for explicit game end ----

composer.callbackQuery(/^game:end:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rid = ctx.match![1];
  const room = await readRoom(rid);
  if (!room?.game) {
    await ctx.reply("No game in progress.");
    return;
  }
  clearGameTimer(rid);
  let updatedRoom: StoredRoom;
  try {
    updatedRoom = await updateRoom(rid, (fresh) => {
      if (!fresh.game) throw new GameActionError("No game.");
      fresh.game.phase = "ended";
    });
  } catch (err) {
    if (GameActionError.is(err)) return;
    throw err;
  }
  await broadcastGameEndApi(ctx.api, updatedRoom.game!);
});

// ---- nop:settings — room settings separator, answer without misleading game message ----

composer.callbackQuery("nop:settings", async (ctx) => {
  await ctx.answerCallbackQuery();
});

// ---- nop: catch-all for non-playable card taps ----

composer.callbackQuery(/^nop:(.+)$/, async (ctx) => {
  if (ctx.callbackQuery.data === "nop:settings") return; // handled above
  await ctx.answerCallbackQuery({ text: "It's not your turn — wait for your go!", show_alert: false });
});

// ---- turn expiry sweeper (reactive: catches expired turns when a message arrives) ----

composer.use(async (ctx, next) => {
  const uid = ctx.from?.id;
  if (!uid) return next();

  const rid = await getUserRoom(uid);
  if (!rid) return next();

  const room = await readRoom(rid);
  if (!room?.game || room.game.phase === "ended") return next();

  const g = room.game;
  if (now() > g.turn_deadline) {
    console.log("[game] reactive timeout sweep", { rid, phase: g.phase });
    await handleTurnTimeout(ctx.api, g, rid, room);
    return;
  }

  return next();
});

/** Exported for room.ts to use in proactive timer scheduling. */
export { handleTurnTimeout };

export default composer;
