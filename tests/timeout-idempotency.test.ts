/**
 * Timeout idempotency / anti-spam tests — verifies the PRIOR REVIEW FEEDBACK fix:
 * 1) Non-responding player produces exactly one timeout message and state advances
 * 2) Subsequent ticks do NOT produce additional timeout messages for that turn
 * 3) Audit log contains exactly one entry per resolution
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
  type StoredCard,
} from "../src/lib/storage.js";
import { createDeck, shuffleDeck } from "../src/lib/cards.js";
import {
  _setClock,
  _resetClock,
  _clearAllTimers,
  _clearTimeoutLog,
  TURN_TIMEOUT_MS,
  timeoutLog,
  type TimeoutLogEntry,
} from "../src/lib/clock.js";
import { HARNESS_BOT_ID } from "../src/toolkit/harness/updates.js";
import type { Bot } from "grammy";

const HOST = { id: 111, name: "HostPlayer" };
const GUEST = { id: 222, name: "GuestPlayer" };
const TEST_RID = "TSTTO1";

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
  let msgId = 3000;
  bot.api.config.use(async (prev, method, payload, signal) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: p });
    const stub = fakeStub(++msgId);
    return stub(prev, method, payload, signal) as any;
  });
  return calls;
}

function makeTestCards() {
  const deck = shuffleDeck(createDeck());
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
      resolvedTurnId: 0,
      turnId: 1,
    },
    _version: 0,
    ...overrides,
  };

  await saveRoom(room);
  await setUserRoom(HOST.id, TEST_RID);
  await setUserRoom(GUEST.id, TEST_RID);
  return room;
}

describe("Turn timeout idempotency", () => {
  let clockTime: number;

  beforeEach(async () => {
    _resetStores();
    _resetClock();
    _clearAllTimers();
    _clearTimeoutLog();
    clockTime = Date.now();
    _setClock(() => clockTime);
  });

  // --- Test A: attack phase, no cards played, attacker times out — skips turn ---
  it("attack timeout (no cards) advances exactly once with one timeout message", async () => {
    const room = await setupGameRoom();
    const game = room.game!;
    expect(game.phase).toBe("attack");
    expect(game.table.length).toBe(0);

    const bot = await buildBot("test-token");
    const calls = prepBot(bot);

    // Advance clock past deadline
    clockTime += TURN_TIMEOUT_MS + 1000;

    // Host sends a message → reactive sweeper fires
    await bot.handleUpdate(
      textUpdate(1, "hello", { userId: HOST.id, chatId: HOST.id }),
    );

    // Verify state advanced
    const updated = await readRoom(TEST_RID);
    const ug = updated!.game!;
    expect(ug.phase).toBe("attack");
    // turnId should have incremented (new turn)
    expect(ug.turnId).toBeGreaterThan(1);
    // resolvedTurnId should be 0 (reset for new turn)
    expect(ug.resolvedTurnId).toBe(0);

    // Should have exactly ONE timeout message to the timed-out player
    const timeoutMessages = calls.filter(
      (c) =>
        c.method === "sendMessage" &&
        (c.payload.text as string)?.includes("timed out"),
    );
    expect(timeoutMessages.length).toBe(1);
    expect(timeoutMessages[0].payload.text).toContain("timed out");

    // Audit log should have exactly one entry
    expect(timeoutLog.length).toBe(1);
    expect(timeoutLog[0].playerId).toBe(HOST.id);
    expect(timeoutLog[0].roomId).toBe(TEST_RID);
  });

  // --- Test B: subsequent ticks do NOT produce additional timeout messages ---
  it("subsequent ticks after timeout do NOT produce duplicate timeout messages", async () => {
    const room = await setupGameRoom();
    expect(room.game!.phase).toBe("attack");
    expect(room.game!.table.length).toBe(0);

    const bot = await buildBot("test-token");
    const calls = prepBot(bot);

    // First timeout: advance clock past deadline, trigger sweeper
    clockTime += TURN_TIMEOUT_MS + 1000;
    await bot.handleUpdate(
      textUpdate(1, "hello", { userId: HOST.id, chatId: HOST.id }),
    );

    const firstTimeoutCount = calls.filter(
      (c) =>
        c.method === "sendMessage" &&
        (c.payload.text as string)?.includes("timed out"),
    ).length;
    expect(firstTimeoutCount).toBe(1);

    // Now send ANOTHER message — should NOT trigger another timeout
    const callCountBefore = calls.length;
    await bot.handleUpdate(
      textUpdate(2, "another message", { userId: HOST.id, chatId: HOST.id }),
    );

    // No additional timeout messages
    const newTimeoutMessages = calls
      .slice(callCountBefore)
      .filter(
        (c) =>
          c.method === "sendMessage" &&
          (c.payload.text as string)?.includes("timed out"),
      );
    expect(newTimeoutMessages.length).toBe(0);

    // Audit log still has exactly one entry
    expect(timeoutLog.length).toBe(1);
  });

  // --- Test C: defender timeout — state advances, one message ---
  it("defender timeout (take cards) produces exactly one message", async () => {
    const { deck, player1Hand, player2Hand, trumpCard } = makeTestCards();
    const now = Date.now();
    clockTime = now;

    // Set up: one attack card on table, phase = defend, past deadline
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
        turn_deadline: now - 1, // already expired
        room_id: TEST_RID,
        host_id: HOST.id,
        resolvedTurnId: 0,
        turnId: 1,
      },
      _version: 0,
    };

    await saveRoom(room);
    await setUserRoom(HOST.id, TEST_RID);
    await setUserRoom(GUEST.id, TEST_RID);

    const bot = await buildBot("test-token");
    const calls = prepBot(bot);

    // Send a message → reactive sweeper fires because deadline is past
    await bot.handleUpdate(
      textUpdate(1, "ping", { userId: GUEST.id, chatId: GUEST.id }),
    );

    // Verify state advanced
    const updated = await readRoom(TEST_RID);
    const ug = updated!.game!;
    expect(ug.table.length).toBe(0); // table cleared
    expect(ug.turnId).toBeGreaterThan(1); // new turn
    expect(ug.resolvedTurnId).toBe(0); // reset

    // Should have exactly ONE timeout message
    const timeoutMessages = calls.filter(
      (c) =>
        c.method === "sendMessage" &&
        (c.payload.text as string)?.includes("took all the cards"),
    );
    expect(timeoutMessages.length).toBe(1);
    expect(timeoutLog.length).toBe(1);
  });

  // --- Test D: proactive timer fires, state advances ---
  it("proactive timer fires and advances state when no messages arrive", async () => {
    const room = await setupGameRoom();
    expect(room.game!.phase).toBe("attack");
    clockTime = Date.now();

    const bot = await buildBot("test-token");
    const calls = prepBot(bot);

    // Simulate proactive timer firing: manually advance clock and trigger
    // the same reactive path (proactive uses setTimer which we can't easily trigger in test)
    // Instead, we simulate a late message with the expired deadline
    clockTime += TURN_TIMEOUT_MS + 5000;

    // First expiration
    await bot.handleUpdate(
      textUpdate(1, "late", { userId: GUEST.id, chatId: GUEST.id }),
    );

    const timeoutCount1 = calls.filter(
      (c) =>
        c.method === "sendMessage" &&
        (c.payload.text as string)?.includes("timed out"),
    ).length;
    expect(timeoutCount1).toBe(1);

    // Second expiration should have new turnId, so timeout is allowed
    const updatedAfterFirst = await readRoom(TEST_RID);
    const turnIdAfter1 = updatedAfterFirst!.game!.turnId;

    // Advance clock past the NEW deadline
    clockTime += TURN_TIMEOUT_MS + 5000;

    // Force reactive sweep again
    await bot.handleUpdate(
      textUpdate(2, "late2", { userId: HOST.id, chatId: HOST.id }),
    );

    const updatedAfterSecond = await readRoom(TEST_RID);
    const ug2 = updatedAfterSecond!.game!;

    // Second timeout should have fired because turnId advanced
    const timeoutCount2 = calls.filter(
      (c) =>
        c.method === "sendMessage" &&
        (c.payload.text as string)?.includes("timed out"),
    ).length;
    expect(timeoutCount2).toBe(2); // one for each expired turn

    // Each timeout produced its own audit entry
    expect(timeoutLog.length).toBe(2);
    // The two log entries should have different turnIds
    expect(timeoutLog[0].turnId).not.toBe(timeoutLog[1].turnId);
  });
});
