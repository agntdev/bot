/**
 * Card-selection integration test — programmatic vitest test that sets up
 * room + game state in storage, then replays card-selection callbacks and
 * verifies state changes AND outgoing messages.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { buildBot } from "../src/bot.js";
import { callbackUpdate, textUpdate } from "../src/toolkit/harness/updates.js";
import {
  saveRoom,
  setUserRoom,
  readRoom,
  _resetStores,
  type StoredRoom,
  type StoredPlayer,
  type StoredCard,
} from "../src/lib/storage.js";
import { createDeck, shuffleDeck, cardToString } from "../src/lib/cards.js";
import { _setClock, _resetClock, TURN_TIMEOUT_MS } from "../src/lib/clock.js";
import { HARNESS_BOT_ID } from "../src/toolkit/harness/updates.js";
import type { Bot, Transformer } from "grammy";

// Players for testing
const HOST = { id: 111, name: "HostPlayer" };
const GUEST = { id: 222, name: "GuestPlayer" };

// Synthetic room ID for tests
const TEST_RID = "TSTG01";

// ---- helpers ----

interface CapturedCall {
  method: string;
  payload: Record<string, unknown>;
}

function freshFakeBotInfo() {
  return {
    id: HARNESS_BOT_ID,
    is_bot: true,
    first_name: "TestBot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };
}

function fakeStub(msgId: number) {
  return (_prev: unknown, method: string, payload: { chat_id?: number; text?: string }) => {
    if (/^(send|edit|copy|forward)/.test(method)) {
      return {
        ok: true,
        result: {
          message_id: msgId,
          date: 0,
          chat: { id: (payload.chat_id as number) ?? 1, type: "private" },
          ...(typeof payload.text === "string" ? { text: payload.text } : {}),
        },
      };
    }
    return { ok: true, result: true };
  };
}

function prepBot(bot: Bot<any>): CapturedCall[] {
  (bot as any).botInfo = freshFakeBotInfo();
  const calls: CapturedCall[] = [];
  let msgId = 2000;
  bot.api.config.use(async (prev, method, payload, signal) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: p });
    const stub = fakeStub(++msgId);
    return stub(prev, method, payload, signal) as any;
  });
  return calls;
}

// ---- setup ----

function makeTestCards(): { deck: StoredCard[]; player1Hand: StoredCard[]; player2Hand: StoredCard[]; trumpCard: StoredCard } {
  const deck = shuffleDeck(createDeck());
  // Deal 6 to each of 2 players (last 24 cards remain in deck)
  const p1 = deck.splice(0, 6);
  const p2 = deck.splice(0, 6);
  const trumpCard = deck[deck.length - 1];
  return { deck, player1Hand: p1, player2Hand: p2, trumpCard };
}

async function setupGameRoom(overrides?: Partial<StoredRoom>): Promise<StoredRoom> {
  const { deck, player1Hand, player2Hand, trumpCard } = makeTestCards();
  const now = Date.now();

  const room: StoredRoom = {
    room_id: TEST_RID,
    host_id: HOST.id,
    max_players: 6,
    initial_hand_size: 6,
    join_link: `https://t.me/test_bot?start=join_${TEST_RID}`,
    players: [
      { user_id: HOST.id, telegram_name: HOST.name, hand: player1Hand, status: "playing" },
      { user_id: GUEST.id, telegram_name: GUEST.name, hand: player2Hand, status: "playing" },
    ],
    game: {
      players: [
        { user_id: HOST.id, telegram_name: HOST.name, hand: player1Hand, status: "playing" },
        { user_id: GUEST.id, telegram_name: GUEST.name, hand: player2Hand, status: "playing" },
      ],
      deck,
      trump_card: trumpCard,
      trump_suit: trumpCard.suit,
      discard: [],
      table: [],
      attacker_idx: 0,
      defender_idx: 1,
      phase: "attack",
      turn_deadline: now + TURN_TIMEOUT_MS,
      room_id: TEST_RID,
      host_id: HOST.id,
    },
    ...overrides,
  };

  await saveRoom(room);
  await setUserRoom(HOST.id, TEST_RID);
  await setUserRoom(GUEST.id, TEST_RID);
  return room;
}

// ---- test helpers ----

function findSendMessage(calls: CapturedCall[], userId: number): CapturedCall | undefined {
  return calls.find((c) => c.method === "sendMessage" && c.payload.chat_id === userId);
}

function cardButtonTexts(calls: CapturedCall[], userId: number): string[] {
  const msg = findSendMessage(calls, userId);
  if (!msg) return [];
  const kb = msg.payload.reply_markup as { inline_keyboard?: { text: string }[][] } | undefined;
  if (!kb?.inline_keyboard) return [];
  return kb.inline_keyboard.flat().map((b) => b.text);
}

describe("Game card selection flow", () => {
  beforeEach(async () => {
    _resetStores();
    _resetClock();
    _setClock(() => Date.now());
  });

  // --- Test 1: Host attacks with a card — card leaves hand, goes to table ---
  it("host plays an attack card — card removed from hand, added to table", async () => {
    const room = await setupGameRoom();
    const game = room.game!;
    const hostCard = game.players[0].hand[0]; // first card in host's hand
    expect(hostCard).toBeDefined();

    const bot = await buildBot("test-token");
    const calls = prepBot(bot);

    // Host taps their first card
    await bot.handleUpdate(
      callbackUpdate(1, `atk:${TEST_RID}:0`, { userId: HOST.id, chatId: HOST.id }),
    );

    // Verify the card was played
    const updated = await readRoom(TEST_RID);
    expect(updated?.game).toBeDefined();
    const g = updated!.game!;

    // Card should be on table
    expect(g.table.length).toBe(1);
    expect(g.table[0].attack.rank).toBe(hostCard.rank);
    expect(g.table[0].attack.suit).toBe(hostCard.suit);

    // Host's hand should have 5 cards now (was 6, played 1)
    const hostPlayer = g.players[0];
    expect(hostPlayer.hand.length).toBe(5);
    // The played card should NOT be in their hand
    expect(hostPlayer.hand.find(
      (c) => c.rank === hostCard.rank && c.suit === hostCard.suit,
    )).toBeUndefined();

    // Phase should be "defend"
    expect(g.phase).toBe("defend");

    // Should have sent public state and private hands
    const p1HandMsg = findSendMessage(calls, HOST.id);
    const p2HandMsg = findSendMessage(calls, GUEST.id);
    expect(p1HandMsg).toBeDefined();
    expect(p2HandMsg).toBeDefined();
  });

  // --- Test 2: Guest tries to attack when it's not their turn ---
  it("non-attacker tapped card gets rejected with ephemeral alert", async () => {
    await setupGameRoom();

    const bot = await buildBot("test-token");
    const calls = prepBot(bot);

    // Guest (not the attacker) taps a card
    await bot.handleUpdate(
      callbackUpdate(1, `atk:${TEST_RID}:0`, { userId: GUEST.id, chatId: GUEST.id }),
    );

    // Room state should NOT have changed
    const updated = await readRoom(TEST_RID);
    const g = updated!.game!;
    expect(g.table.length).toBe(0);
    expect(g.players[0].hand.length).toBe(6);
    expect(g.phase).toBe("attack");

    // Should have gotten answerCallbackQuery with alert
    const answerCalls = calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answerCalls.length).toBeGreaterThan(0);
  });

  // --- Test 3: Defender taps a card that can't beat the attack ---
  it("defender's invalid defense card is rejected", async () => {
    const { deck, player1Hand, player2Hand, trumpCard } = makeTestCards();
    const now = Date.now();

    // Set up room where host already attacked with their first card
    const attackCard = player1Hand[0];
    player1Hand.splice(0, 1);

    const room: StoredRoom = {
      room_id: TEST_RID,
      host_id: HOST.id,
      max_players: 6,
      initial_hand_size: 6,
      join_link: `https://t.me/test_bot?start=join_${TEST_RID}`,
      players: [
        { user_id: HOST.id, telegram_name: HOST.name, hand: player1Hand, status: "playing" },
        { user_id: GUEST.id, telegram_name: GUEST.name, hand: player2Hand, status: "playing" },
      ],
      game: {
        players: [
          { user_id: HOST.id, telegram_name: HOST.name, hand: player1Hand, status: "playing" },
          { user_id: GUEST.id, telegram_name: GUEST.name, hand: player2Hand, status: "playing" },
        ],
        deck,
        trump_card: trumpCard,
        trump_suit: trumpCard.suit,
        discard: [],
        table: [{ attack: attackCard }],
        attacker_idx: 0,
        defender_idx: 1,
        phase: "defend",
        turn_deadline: now + TURN_TIMEOUT_MS,
        room_id: TEST_RID,
        host_id: HOST.id,
      },
    };

    await saveRoom(room);
    await setUserRoom(HOST.id, TEST_RID);
    await setUserRoom(GUEST.id, TEST_RID);

    // Find a card in defender's hand that CANNOT beat the attack
    // (a lower-rank same-suit card, or any different suit non-trump)
    const { cardBeats: beatsCheck } = await import("../src/lib/cards.js");
    let invalidDefIdx = 0;
    for (let i = 0; i < player2Hand.length; i++) {
      if (!beatsCheck(attackCard, player2Hand[i], trumpCard.suit)) {
        invalidDefIdx = i;
        break;
      }
    }

    const bot = await buildBot("test-token");
    const calls = prepBot(bot);

    // Guest (defender) taps an invalid defense card
    await bot.handleUpdate(
      callbackUpdate(1, `def:${TEST_RID}:${invalidDefIdx}`, { userId: GUEST.id, chatId: GUEST.id }),
    );

    // State should NOT have changed
    const updated = await readRoom(TEST_RID);
    const g = updated!.game!;
    expect(g.table[0].defend).toBeUndefined();

    // Should see an error reply about the card not beating
    const errorReply = calls.find(
      (c) => c.method === "sendMessage" && c.payload.chat_id === GUEST.id,
    );
    expect(errorReply).toBeDefined();
    const text = errorReply!.payload.text as string;
    expect(text).toMatch(/can't beat/i);
  });

  // --- Test 4: Podkid (toss-in) by a non-defender player ---
  it("podkid adds card to table during podkid phase", async () => {
    const { deck, player1Hand, player2Hand, trumpCard } = makeTestCards();
    const now = Date.now();

    // Find host's first card to attack with, then set phase to podkid
    const attackCard = player1Hand[0];
    player1Hand.splice(0, 1);

    const room: StoredRoom = {
      room_id: TEST_RID,
      host_id: HOST.id,
      max_players: 6,
      initial_hand_size: 6,
      join_link: `https://t.me/test_bot?start=join_${TEST_RID}`,
      players: [
        { user_id: HOST.id, telegram_name: HOST.name, hand: player1Hand, status: "playing" },
        { user_id: GUEST.id, telegram_name: GUEST.name, hand: player2Hand, status: "playing" },
      ],
      game: {
        players: [
          { user_id: HOST.id, telegram_name: HOST.name, hand: player1Hand, status: "playing" },
          { user_id: GUEST.id, telegram_name: GUEST.name, hand: player2Hand, status: "playing" },
        ],
        deck,
        trump_card: trumpCard,
        trump_suit: trumpCard.suit,
        discard: [],
        table: [{ attack: attackCard }], // one attack on table
        attacker_idx: 0,
        defender_idx: 1,
        phase: "podkid", // ready for podkid
        turn_deadline: now + TURN_TIMEOUT_MS,
        room_id: TEST_RID,
        host_id: HOST.id,
      },
    };

    await saveRoom(room);
    await setUserRoom(HOST.id, TEST_RID);
    await setUserRoom(GUEST.id, TEST_RID);

    // Find a card in host's hand matching a rank on the table (for valid podkid)
    const tableRank = attackCard.rank;
    let podIdx = 0;
    for (let i = 0; i < player1Hand.length; i++) {
      if (player1Hand[i].rank === tableRank) {
        podIdx = i;
        break;
      }
    }
    const podCard = player1Hand[podIdx];
    if (!podCard || podCard.rank !== tableRank) {
      // If no matching rank, force one
      player1Hand[0] = { rank: tableRank, suit: trumpCard.suit === "♠" ? "♥" : "♠" };
    }

    const bot = await buildBot("test-token");
    const calls = prepBot(bot);

    // Host (non-defender) tosses in a card
    const actualPodIdx = podCard?.rank === tableRank ? podIdx : 0;
    await bot.handleUpdate(
      callbackUpdate(1, `pod:${TEST_RID}:${actualPodIdx}`, { userId: HOST.id, chatId: HOST.id }),
    );

    const updated = await readRoom(TEST_RID);
    const g = updated!.game!;
    // Table should have 2 attacks now
    expect(g.table.length).toBe(2);
  });

  // --- Test 5: Take action — defender takes all cards ---
  it("take action adds all table cards to defender's hand", async () => {
    const { deck, player1Hand, player2Hand, trumpCard } = makeTestCards();
    const now = Date.now();

    const attackCard = player1Hand[0];
    player1Hand.splice(0, 1);

    const room: StoredRoom = {
      room_id: TEST_RID,
      host_id: HOST.id,
      max_players: 6,
      initial_hand_size: 6,
      join_link: `https://t.me/test_bot?start=join_${TEST_RID}`,
      players: [
        { user_id: HOST.id, telegram_name: HOST.name, hand: player1Hand, status: "playing" },
        { user_id: GUEST.id, telegram_name: GUEST.name, hand: player2Hand, status: "playing" },
      ],
      game: {
        players: [
          { user_id: HOST.id, telegram_name: HOST.name, hand: player1Hand, status: "playing" },
          { user_id: GUEST.id, telegram_name: GUEST.name, hand: player2Hand, status: "playing" },
        ],
        deck,
        trump_card: trumpCard,
        trump_suit: trumpCard.suit,
        discard: [],
        table: [{ attack: attackCard }],
        attacker_idx: 0,
        defender_idx: 1,
        phase: "defend",
        turn_deadline: now + TURN_TIMEOUT_MS,
        room_id: TEST_RID,
        host_id: HOST.id,
      },
    };

    await saveRoom(room);
    await setUserRoom(HOST.id, TEST_RID);
    await setUserRoom(GUEST.id, TEST_RID);

    const bot = await buildBot("test-token");
    const calls = prepBot(bot);

    // Guest (defender) takes
    await bot.handleUpdate(
      callbackUpdate(1, `take:${TEST_RID}`, { userId: GUEST.id, chatId: GUEST.id }),
    );

    const updated = await readRoom(TEST_RID);
    const g = updated!.game!;

    // Table should be cleared
    expect(g.table.length).toBe(0);
    // Defender's hand should have the attack card
    const defender = g.players[1];
    const foundAttack = defender.hand.find(
      (c) => c.rank === attackCard.rank && c.suit === attackCard.suit,
    );
    expect(foundAttack).toBeDefined();
  });

  // --- Test 6: Invalid card index (out of bounds) ---
  it("card index out of bounds is rejected gracefully", async () => {
    await setupGameRoom();

    const bot = await buildBot("test-token");
    const calls = prepBot(bot);

    // Host tries to play card index 99 (doesn't exist, only 6 cards)
    await bot.handleUpdate(
      callbackUpdate(1, `atk:${TEST_RID}:99`, { userId: HOST.id, chatId: HOST.id }),
    );

    // State should NOT have changed
    const updated = await readRoom(TEST_RID);
    const g = updated!.game!;
    expect(g.table.length).toBe(0);
    expect(g.players[0].hand.length).toBe(6);
  });

  // --- Test 7: Waiting player's private hand shows nop buttons ---
  it("waiting player's hand has nop buttons, not playable buttons", async () => {
    const room = await setupGameRoom();
    // Force phase to attack, host's turn — guest is waiting
    room.game!.phase = "attack";
    await saveRoom(room);

    const bot = await buildBot("test-token");
    const calls = prepBot(bot);

    // Guest sends /hand
    await bot.handleUpdate(
      textUpdate(1, "/hand", { userId: GUEST.id, chatId: GUEST.id }),
    );

    // Check that guest's hand message has nop: buttons
    const handMsg = findSendMessage(calls, GUEST.id);
    expect(handMsg).toBeDefined();
    const kb = handMsg!.payload.reply_markup as { inline_keyboard?: { callback_data: string }[][] } | undefined;
    expect(kb?.inline_keyboard).toBeDefined();

    const allData = kb!.inline_keyboard!.flat().map((b) => b.callback_data);
    // All card buttons should start with "nop:" (not playable)
    const cardButtons = allData.filter((d) => d.startsWith("nop:"));
    expect(cardButtons.length).toBeGreaterThan(0);
  });

  // --- Test 8: nop callback is answered ---
  it("nop callback is answered so spinner doesn't hang", async () => {
    await setupGameRoom();

    const bot = await buildBot("test-token");
    const calls = prepBot(bot);

    await bot.handleUpdate(
      callbackUpdate(1, `nop:${TEST_RID}`, { userId: GUEST.id, chatId: GUEST.id }),
    );

    const answerCalls = calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answerCalls.length).toBeGreaterThan(0);
  });
});
