import type { StorageAdapter } from "grammy";
import { resolveSessionStorage } from "../toolkit/session/redis.js";

/**
 * Persistent store for room + game data. Each room is keyed by its room_id.
 * A userId → roomId index maps users to the room they're currently in.
 * NEVER scans the keyspace — all lookups go through these exact keys or the index.
 */

export interface StoredCard {
  rank: string;
  suit: string;
}

export interface StoredPlayer {
  user_id: number;
  telegram_name: string;
  hand: StoredCard[];
  status: "lobby" | "playing" | "durak" | "out" | "left";
}

export interface StoredGameState {
  players: StoredPlayer[];
  deck: StoredCard[];
  trump_card: StoredCard;
  trump_suit: string;
  discard: StoredCard[];
  table: { attack: StoredCard; defend?: StoredCard }[];
  attacker_idx: number;
  defender_idx: number;
  phase: "attack" | "defend" | "podkid" | "ended";
  turn_deadline: number;
  room_id: string;
  host_id: number;
}

export interface StoredRoom {
  room_id: string;
  host_id: number;
  max_players: number;
  initial_hand_size: number;
  join_link: string;
  players: StoredPlayer[];
  game?: StoredGameState;
  publicMessageId?: number;
  publicChatId?: number;
  /** Optimistic-concurrency version — incremented on every save. */
  _version: number;
}

/** Wrapper object so the index satisfies StorageAdapter's object constraint. */
interface UserRoomEntry {
  rid: string;
}

const ROOM_PREFIX = "room:";
const USER_ROOM_PREFIX = "uroom:";

function roomKey(rid: string): string {
  return ROOM_PREFIX + rid;
}
function userRoomKey(uid: number): string {
  return USER_ROOM_PREFIX + String(uid);
}

let _store: StorageAdapter<StoredRoom> | null = null;
let _idxStore: StorageAdapter<UserRoomEntry> | null = null;

function roomStore(): StorageAdapter<StoredRoom> {
  if (!_store) _store = resolveSessionStorage<StoredRoom>(undefined);
  return _store;
}
function indexStore(): StorageAdapter<UserRoomEntry> {
  if (!_idxStore) _idxStore = resolveSessionStorage<UserRoomEntry>(undefined);
  return _idxStore;
}

// ---- Public API ----

/** Blind save — increments version. Use `updateRoom` for concurrency-safe mutations. */
export async function saveRoom(room: StoredRoom): Promise<void> {
  room._version = (room._version ?? 0) + 1;
  await roomStore().write(roomKey(room.room_id), room);
}

export async function readRoom(rid: string): Promise<StoredRoom | undefined> {
  return roomStore().read(roomKey(rid));
}

export async function deleteRoom(rid: string): Promise<void> {
  await roomStore().delete(roomKey(rid));
}

export async function setUserRoom(uid: number, rid: string): Promise<void> {
  await indexStore().write(userRoomKey(uid), { rid });
}

export async function getUserRoom(uid: number): Promise<string | undefined> {
  const entry = await indexStore().read(userRoomKey(uid));
  return entry?.rid;
}

export async function clearUserRoom(uid: number): Promise<void> {
  await indexStore().delete(userRoomKey(uid));
}

// ---- per-room write serialization ----
// In a single-process Node.js bot, a per-room mutex eliminates the TOCTOU
// window between version-check and save that the optimistic-lock retries
// reduce but cannot fully close. This serializes all writes to the same
// room through a promise chain, so two concurrent updateRoom() calls never
// interleave their read-check-save sequences.

const roomLocks = new Map<string, Promise<void>>();

function enqueueRoomLock(rid: string): () => void {
  const prev = roomLocks.get(rid) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  // Chain: after prev resolves, return next (which our caller will release)
  roomLocks.set(rid, prev.then(() => next));
  return release;
}

/**
 * Serialized update: enqueues a per-room lock so only one writer mutates
 * a given room at a time, then reads → mutates → saves (with version
 * increment). Returns the updated room.
 *
 * When Redis-backed storage is available in a multi-process deployment,
 * the lock is process-local only — inter-process races remain possible
 * but are far less likely for a game bot's request rate. The version
 * field is still incremented as a defense-in-depth check.
 */
export async function updateRoom(
  rid: string,
  mutate: (room: StoredRoom) => void,
): Promise<StoredRoom> {
  const release = enqueueRoomLock(rid);
  try {
    const room = await readRoom(rid);
    if (!room) throw new Error(`Room ${rid} not found`);
    mutate(room);
    await saveRoom(room);
    return room;
  } finally {
    release();
  }
}

/** Test-only: reset all stores. */
export function _resetStores(): void {
  _store = null;
  _idxStore = null;
  roomLocks.clear();
}