import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { mainMenuKeyboard } from "../toolkit/index.js";
import {
  readRoom,
  setUserRoom,
  getUserRoom,
  clearUserRoom,
  saveRoom,
  deleteRoom,
  updateRoom,
} from "../lib/storage.js";
import type { StoredPlayer } from "../lib/storage.js";

// The /start handler renders the bot's MAIN MENU — the primary way users operate
// a button-first bot. A feature adds its own button by calling
// `registerMainMenuItem(...)` in its own `src/handlers/<slug>.ts`; this handler
// renders whatever is registered (plus a Help button), so you do NOT edit this
// file to add a feature. Send ONE message — no placeholder line above the menu.
const composer = new Composer<Ctx>();

const WELCOME = "👋 Welcome! Tap a button below to get started.";

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

  if (existing.game && existing.game.phase !== "ended") {
    return; // caller handles the error message
  }

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

/** Handle a join via /start join_XXXXXX deep link. Processes the join here
 *  so the update DOES NOT fall through to the global fallback. */
async function handleJoinDeepLink(ctx: Ctx, rid: string): Promise<void> {
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
    await leaveCurrentRoom(uid);
  }

  const room = await readRoom(rid);
  if (!room) {
    await ctx.reply("Couldn't find that room — it may have ended. Ask the host for a fresh invite link.");
    return;
  }

  if (room.game) {
    await ctx.reply("That game's already in progress — wait for the next one!");
    return;
  }

  const activePlayers = room.players.filter((p) => p.status !== "left");
  if (activePlayers.length >= room.max_players && !room.players.some((p) => p.user_id === uid)) {
    await ctx.reply("The room's full — wait for the next game.");
    return;
  }

  const joinerName = ctx.from!.first_name || "Player";
  let updatedRoom;
  try {
    updatedRoom = await updateRoom(rid, (r) => {
      const existing = r.players.find((p) => p.user_id === uid);
      if (existing) {
        if (existing.status !== "left") {
          throw new Error("already-in-room");
        }
        existing.status = "lobby";
      } else {
        r.players.push(makePlayer(uid, joinerName));
      }
    });
  } catch (err) {
    if (err instanceof Error && err.message === "already-in-room") {
      await ctx.reply("You're already in this room!");
      return;
    }
    throw err;
  }

  await setUserRoom(uid, rid);

  const playerNames = updatedRoom.players.filter((p) => p.status !== "left").map((p) => p.telegram_name).join(", ");
  await ctx.reply(
    `🚪 Joined room ${rid}!\n\n${playerNames}\n\nPlayers: ${updatedRoom.players.filter(p => p.status !== "left").length}/${updatedRoom.max_players}`,
  );

  // Notify other players in the room
  for (const p of updatedRoom.players) {
    if (p.user_id !== uid && p.status !== "left") {
      try {
        await ctx.api.sendMessage(
          p.user_id,
          `👋 ${joinerName} joined the room!\n\n${playerNames}\n\nPlayers: ${updatedRoom.players.filter(p => p.status !== "left").length}/${updatedRoom.max_players}`,
        );
      } catch {}
    }
  }
}

composer.command("start", async (ctx) => {
  // If the /start has a join_XXXXXX deep link, process the join HERE
  // (NOT via next()) so the update doesn't fall through to the global fallback.
  if (ctx.match && typeof ctx.match === "string" && ctx.match.startsWith("join_")) {
    const rid = ctx.match.slice("join_".length).toUpperCase();
    await handleJoinDeepLink(ctx, rid);
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
