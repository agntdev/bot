import { Composer, type Api } from "grammy";
import type { Ctx } from "../bot.js";
import {
  readRoom,
  saveRoom,
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

  const loaded = await loadRoomGame(ctx, rid);
  if (!loaded) return;
  const { room, game: g } = loaded;

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
      return handlePodkid(ctx, g, rid, uid, idx, room);
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

  // Cap attacks at 6 (defender's max hand size)
  if (g.table.length >= 6) {
    await ctx.reply("Max attacks on the table — tap ✅ Done attacking.");
    return;
  }

  const card = attacker.hand.splice(idx, 1)[0];
  g.table.push({ attack: card });
  g.turn_deadline = now() + TURN_TIMEOUT_MS;

  console.log("[game] attack played", {
    rid, uid, card: cardToString(card), tableSize: g.table.length,
  });

  await saveRoom(room);
  scheduleTurnTimer(ctx.api, rid, g.turn_deadline);
  await broadcastPublicStateApi(ctx.api, g);
  await sendPrivateHandApi(ctx.api, g, attacker, rid);
  await sendPrivateHandApi(ctx.api, g, g.players[g.defender_idx], rid);
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
    await ctx.reply(
      `${cardToString(defendCard)} can't beat ${cardToString(attack)}. Pick a higher rank of the same suit or a trump.`,
    );
    return;
  }

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
  if (allDefended) scheduleTurnTimer(ctx.api, rid, g.turn_deadline);
  await broadcastPublicStateApi(ctx.api, g);
  await sendPrivateHandApi(ctx.api, g, defender, rid);

  // When transitioning to podkid, update ALL non-defender players'
  // hands so they see podkid action buttons.
  if (allDefended) {
    for (const p of g.players) {
      if (p.status === "playing" && p.user_id !== defender.user_id) {
        await sendPrivateHandApi(ctx.api, g, p, rid);
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
  room: StoredRoom,
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

  const card = player.hand.splice(idx, 1)[0];
  g.table.push({ attack: card });
  g.turn_deadline = now() + TURN_TIMEOUT_MS;

  console.log("[game] podkid card", {
    rid, uid, card: cardToString(card), tableSize: g.table.length,
  });

  await saveRoom(room);
  scheduleTurnTimer(ctx.api, rid, g.turn_deadline);
  await broadcastPublicStateApi(ctx.api, g);
  await sendPrivateHandApi(ctx.api, g, player, rid);
  await sendPrivateHandApi(ctx.api, g, g.players[g.defender_idx], rid);
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

  for (const pair of g.table) {
    defender.hand.push(pair.attack);
    if (pair.defend) defender.hand.push(pair.defend);
  }
  const takenCount = g.table.reduce((n, p) => n + 1 + (p.defend ? 1 : 0), 0);
  g.table = [];

  const upTo = initialHandSize(room);
  for (const p of g.players) {
    if (p.user_id !== defender.user_id && isPlayerActive(p)) {
      refillHand(g, p, upTo);
    }
  }

  // Defender took — they don't get to attack; skip to next player
  g.phase = "attack";
  g.turn_deadline = now() + TURN_TIMEOUT_MS;

  console.log("[game] defender took cards", { rid, uid, takenCount });

  await saveRoom(room);
  scheduleTurnTimer(ctx.api, rid, g.turn_deadline);
  await broadcastPublicStateApi(ctx.api, g);

  await sendPrivateHandApi(ctx.api, g, defender, rid);
  for (const p of g.players) {
    if (p.user_id !== defender.user_id && isPlayerActive(p)) {
      await sendPrivateHandApi(ctx.api, g, p, rid);
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
      console.warn("[game] non-attacker tried done in attack phase", {
        rid, uid, attackerId: attacker?.user_id,
      });
      await ctx.answerCallbackQuery({ text: "Only the current attacker can finish.", show_alert: true });
      return;
    }

    // Attacker done → transition to defend phase
    g.phase = "defend";
    g.turn_deadline = now() + TURN_TIMEOUT_MS;
    console.log("[game] attacker done → defend phase", { rid, tableSize: g.table.length });
    await saveRoom(room);
    scheduleTurnTimer(ctx.api, rid, g.turn_deadline);
    await broadcastPublicStateApi(ctx.api, g);
    await sendPrivateHandApi(ctx.api, g, g.players[g.defender_idx], rid);
    for (const p of g.players) {
      if (p.user_id !== g.players[g.defender_idx]?.user_id && isPlayerActive(p)) {
        await sendPrivateHandApi(ctx.api, g, p, rid);
      }
    }
    return;
  }

  if (g.phase === "podkid") {
    // Validate caller: must be an active non-defender player
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
    await advanceTurn(ctx.api, g, rid, room);
    return;
  }

  await ctx.reply("Nothing to finish right now.");
});

async function advanceTurn(
  api: Api,
  g: StoredGameState,
  rid: string,
  room: StoredRoom,
): Promise<void> {
  clearGameTimer(rid);

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
    await broadcastGameEndApi(api, g);
    return;
  }

  nextAttackerDefender(g);
  g.phase = "attack";
  g.turn_deadline = now() + TURN_TIMEOUT_MS;
  console.log("[game] turn advanced", { rid, newAttacker: g.players[g.attacker_idx]?.telegram_name, beatCount });

  await saveRoom(room);
  scheduleTurnTimer(api, rid, g.turn_deadline);
  await broadcastPublicStateApi(api, g);

  for (const p of g.players) {
    if (isPlayerActive(p)) {
      await sendPrivateHandApi(api, g, p, rid);
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
  clearGameTimer(rid);

  const upTo = initialHandSize(room);

  if (g.phase === "attack") {
    if (g.table.length > 0) {
      const defender = g.players[g.defender_idx];
      if (defender) {
        for (const pair of g.table) {
          defender.hand.push(pair.attack);
          if (pair.defend) defender.hand.push(pair.defend);
        }
      }
      g.table = [];
    }
    for (const p of g.players) {
      if (isPlayerActive(p)) refillHand(g, p, upTo);
    }
    if (checkGameEnd(g)) {
      await saveRoom(room);
      await broadcastGameEndApi(api, g);
      return;
    }
    nextAttackerDefender(g);
    g.phase = "attack";
    g.turn_deadline = now() + TURN_TIMEOUT_MS;
    await saveRoom(room);
    scheduleTurnTimer(api, rid, g.turn_deadline);
    await broadcastPublicStateApi(api, g);
    for (const p of g.players) {
      if (isPlayerActive(p)) await sendPrivateHandApi(api, g, p, rid);
    }
    try {
      await api.sendMessage(g.players[g.attacker_idx].user_id, "⏰ Turn timed out — auto-passed to next player.");
    } catch {}
  } else if (g.phase === "defend") {
    const defender = g.players[g.defender_idx];
    if (defender) {
      for (const pair of g.table) {
        defender.hand.push(pair.attack);
        if (pair.defend) defender.hand.push(pair.defend);
      }
    }
    g.table = [];
    for (const p of g.players) {
      if (isPlayerActive(p)) refillHand(g, p, upTo);
    }
    if (checkGameEnd(g)) {
      await saveRoom(room);
      await broadcastGameEndApi(api, g);
      return;
    }
    nextAttackerDefender(g);
    g.phase = "attack";
    g.turn_deadline = now() + TURN_TIMEOUT_MS;
    await saveRoom(room);
    scheduleTurnTimer(api, rid, g.turn_deadline);
    await broadcastPublicStateApi(api, g);
    for (const p of g.players) {
      if (isPlayerActive(p)) await sendPrivateHandApi(api, g, p, rid);
    }
    try {
      if (defender) await api.sendMessage(defender.user_id, "⏰ Time's up — you took all the cards.");
    } catch {}
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
      if (defender) {
        for (const pair of g.table) {
          defender.hand.push(pair.attack);
          if (pair.defend) defender.hand.push(pair.defend);
        }
      }
      g.table = [];
    }
    await advanceTurn(api, g, rid, room);
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
    // Mid-game leave
    player.status = "left";
    const g = room.game;
    const gamePlayer = g.players.find((p) => p.user_id === uid);
    if (gamePlayer) {
      gamePlayer.status = "left";

      const isAttacker = g.players[g.attacker_idx]?.user_id === uid;
      const isDefender = g.players[g.defender_idx]?.user_id === uid;

      if (isAttacker && g.phase === "attack") {
        if (g.table.length > 0) {
          await handleTurnTimeout(ctx.api, g, rid, room);
        } else {
          nextAttackerDefender(g);
          g.phase = "attack";
          g.turn_deadline = now() + TURN_TIMEOUT_MS;
          await saveRoom(room);
          scheduleTurnTimer(ctx.api, rid, g.turn_deadline);
          await broadcastPublicStateApi(ctx.api, g);
          for (const p of g.players) {
            if (isPlayerActive(p)) await sendPrivateHandApi(ctx.api, g, p, rid);
          }
        }
      } else if (isDefender && (g.phase === "defend" || g.phase === "podkid")) {
        await handleTurnTimeout(ctx.api, g, rid, room);
      } else {
        await saveRoom(room);
        await broadcastPublicStateApi(ctx.api, g);
      }
    } else {
      await saveRoom(room);
    }
    await ctx.reply("You've left the game. 👋");
  } else {
    // Lobby leave
    room.players = room.players.filter((p) => p.user_id !== uid);
    if (room.players.length === 0) {
      await deleteRoom(rid);
    } else {
      if (room.host_id === uid && room.players.length > 0) {
        room.host_id = room.players[0].user_id;
      }
      await saveRoom(room);

      const msg =
        `🚪 ${player.telegram_name} left the room.\n\n` +
        formatPlayerListLobby(room.players, room.max_players);
      for (const p of room.players) {
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
  room.game.phase = "ended";
  await saveRoom(room);
  await broadcastGameEndApi(ctx.api, room.game);
});

// ---- nop: catch-all for non-playable card taps ----

composer.callbackQuery(/^nop:(.+)$/, async (ctx) => {
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
