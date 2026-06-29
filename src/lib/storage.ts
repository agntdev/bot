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
  status: "lobby" | "playing" | "durak" | "left";
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
  phase: "attack" | "defend" | "podkid" | "take" | "ended";
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

export async function saveRoom(room: StoredRoom): Promise<void> {
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

/** Test-only: reset all stores. */
export function _resetStores(): void {
  _store = null;
  _idxStore = null;
}