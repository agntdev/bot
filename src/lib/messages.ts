import type { Api } from "grammy";
import type { StoredGameState, StoredPlayer, StoredCard } from "./storage.js";
import { cardToString, tableRanks } from "./cards.js";
import { inlineButton } from "../toolkit/index.js";
import { clearGameTimer } from "./clock.js";

/** Build the public game-state text shown in the shared channel/DM. */
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
    `Players: ${g.players.map((p) => p.telegram_name + (p.status === "durak" ? " 💀" : p.status === "out" ? " ✅" : "") + (p.hand.length ? ` (${p.hand.length})` : "")).join(", ")}`
  );
}

/**
 * Send a private hand update to a single player.
 * Works with plain `Api` so proactive timer callbacks can use it without a Ctx.
 */
export async function sendPrivateHandApi(
  api: Api,
  game: StoredGameState,
  player: StoredPlayer,
  rid: string,
): Promise<void> {
  const uid = player.user_id;
  const hand = player.hand;

  if (hand.length === 0) return;

  const isAttacker = game.players[game.attacker_idx]?.user_id === uid;
  const isDefender = game.players[game.defender_idx]?.user_id === uid;

  let canAct = false;
  let actionPrefix = "";
  if (game.phase === "attack" && isAttacker) {
    canAct = true;
    actionPrefix = "atk";
  } else if (game.phase === "defend" && isDefender) {
    canAct = true;
    actionPrefix = "def";
  } else if (game.phase === "podkid" && !isDefender && player.status === "playing") {
    canAct = true;
    actionPrefix = "pod";
  }

  const isWaiting = !canAct;

  // Build card buttons (3 per row)
  const rows: ReturnType<typeof inlineButton>[][] = [];
  for (let i = 0; i < hand.length; i += 3) {
    rows.push(
      hand.slice(i, i + 3).map((c: StoredCard, j: number) => {
        const idx = i + j;
        if (!canAct) {
          return inlineButton(`· ${c.rank}${c.suit}`, `nop:${rid}`);
        }
        // During attack with cards on table, only show matching-rank cards
        if (game.phase === "attack" && game.table.length > 0) {
          const activeRanks = tableRanks(game.table);
          if (!activeRanks.has(c.rank)) {
            return inlineButton(`· ${c.rank}${c.suit}`, `nop:${rid}`);
          }
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
  if (game.phase === "podkid" && !isDefender && player.status === "playing") {
    actionRow.push(inlineButton("✅ Done tossing", `done:${rid}`));
  }

  const buttons = [...rows];
  if (actionRow.length > 0) buttons.push(actionRow);

  const phaseLabel =
    game.phase === "attack" && isAttacker
      ? "🎯 Your turn to attack!"
      : game.phase === "defend" && isDefender
        ? "🛡 Defend!"
        : game.phase === "podkid" && !isDefender && player.status === "playing"
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
    await api.sendMessage(uid, text, {
      reply_markup: { inline_keyboard: buttons },
    });
  } catch {
    // user blocked — skip
  }
}

/** Broadcast public game state to all active players. */
export async function broadcastPublicStateApi(api: Api, game: StoredGameState): Promise<void> {
  const text = publicStateText(game);
  for (const p of game.players) {
    if (p.status === "left" || p.status === "durak" || p.status === "out") continue;
    try {
      await api.sendMessage(p.user_id, text);
    } catch {
      // blocked
    }
  }
}

/** Broadcast game-over message to all players. */
export async function broadcastGameEndApi(api: Api, g: StoredGameState): Promise<void> {
  clearGameTimer(g.room_id);
  const durak = g.players.find((p) => p.status === "durak");
  const durakName = durak ? durak.telegram_name : "Unknown";

  function standing(p: typeof g.players[number]): string {
    if (p.status === "durak") return "💀 дурак (loser)";
    if (p.status === "out") return "🏆 finished";
    return `${p.hand.length} card${p.hand.length !== 1 ? "s" : ""}`;
  }

  const text =
    `🏁 Game over!\n\n` +
    `${durakName} is the durak! 👑💀\n\n` +
    `Final standings:\n` +
    g.players.map((p) => `${p.telegram_name} — ${standing(p)}`).join("\n");

  console.log("[game] broadcasting game end", { roomId: g.room_id, durakName });

  for (const p of g.players) {
    if (p.status === "left") continue;
    try {
      await api.sendMessage(p.user_id, text);
    } catch {
      // blocked
    }
  }
}

/** Format lobby player list. */
export function formatPlayerListLobby(players: StoredPlayer[], max: number): string {
  const names = players.map((p) => `${p.telegram_name}`);
  return `${names.join(", ")}\n\nPlayers: ${players.filter(p => p.status !== "left").length}/${max}`;
}
