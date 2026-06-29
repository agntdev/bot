/** Card types and game-logic helpers for Podkidnoy Durak. */

export interface Card {
  rank: string;
  suit: string;
}

/** 36-card deck: 6–A in four suits. */
export const RANKS = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;
export const SUITS = ["♠", "♥", "♦", "♣"] as const;

/** Rank → numeric strength (lowest 6=0, highest A=8). */
export const RANK_ORDER: Record<string, number> = Object.fromEntries(
  RANKS.map((r, i) => [r, i]),
) as Record<string, number>;

/** Create a fresh 36-card deck (unshuffled). */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/** Fisher-Yates shuffle in place. Returns the same array. */
export function shuffleDeck(deck: Card[]): Card[] {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** Can `defend` beat `attack` given `trumpSuit`? */
export function cardBeats(attack: Card, defend: Card, trumpSuit: string): boolean {
  if (attack.suit === defend.suit) {
    return RANK_ORDER[defend.rank] > RANK_ORDER[attack.rank];
  }
  return defend.suit === trumpSuit;
}

/** Human-readable card, e.g. "A♠". */
export function cardToString(c: Card): string {
  return `${c.rank}${c.suit}`;
}

/** Hand as space-separated string. */
export function handToString(hand: Card[]): string {
  return hand.map(cardToString).join(" ");
}

/** Ranks currently on the table (for podkid eligibility). */
export function tableRanks(table: { attack: Card; defend?: Card }[]): Set<string> {
  const ranks = new Set<string>();
  for (const pair of table) {
    ranks.add(pair.attack.rank);
    if (pair.defend) ranks.add(pair.defend.rank);
  }
  return ranks;
}