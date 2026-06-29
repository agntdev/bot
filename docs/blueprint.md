# Podkidnoy Durak Card Game Bot — Bot specification

**Archetype:** custom

**Voice:** casual and friendly — write every user-facing message, button label, error, and empty state in this voice.

A Telegram bot implementing the 2-6 player Russian card game 'Подкидной дурак'. Players join via invite links to play in memory-based rooms with full rule enforcement. The bot manages game state, handles turns, and provides private hand updates and public game state messages.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Casual Telegram users
- Russian card game enthusiasts
- Friends groups playing together

## Success criteria

- Players can create and join game rooms via invite links
- Full game rules are enforced with server-side validation
- Private hand updates and public game state messages are synchronized correctly
- Turn timers and auto-actions function as specified
- Game ends correctly when players are eliminated

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open the main menu with Create/Join options
- **Create Room** (button, actor: user, callback: room:create) — Create a new game room with default settings
- **Join Room** (button, actor: user, callback: room:join) — Prompt for a room invite link to join an existing game
- **/hand** (command, actor: user, command: /hand) — Resend the current player's private hand message

## Flows

### Room Creation
_Trigger:_ room:create

1. Display room creation settings (max players, hand size)
2. Generate room ID and invite link
3. Show room lobby with join status

_Data touched:_ Room, Player

### Game Start
_Trigger:_ /start

1. Create deck and shuffle
2. Deal cards to players
3. Reveal trump card
4. Determine first attacker

_Data touched:_ Deck, GameState

### Attack Turn
_Trigger:_ attack:card

1. Validate attacker status
2. Remove card from attacker's hand
3. Add card to table
4. Update public game state

_Data touched:_ Player, GameState

### Defend Turn
_Trigger:_ defend:card

1. Validate defender status
2. Check if card beats attack
3. Add card to table
4. Update public game state

_Data touched:_ Player, GameState

### Podkid Turn
_Trigger:_ podkid:card

1. Validate podkid eligibility
2. Remove card from player's hand
3. Add card to table
4. Update public game state

_Data touched:_ Player, GameState

### Game End
_Trigger:_ game:end

1. Check for players with no cards
2. Declare 'дурок' if fewer than 2 players remain
3. Send final game state message

_Data touched:_ Player, GameState

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **Player** _(retention: session)_ — A participant in the game
  - fields: user_id, telegram_name, hand, status
- **Card** _(retention: session)_ — A playing card with rank and suit
  - fields: rank, suit
- **Deck** _(retention: session)_ — A shuffled deck of 36 cards
  - fields: cards
- **GameState** _(retention: session)_ — The current state of a game room
  - fields: players, deck, trump_card, trump_suit, discard, table, attacker_idx, defender_idx, phase, turn_deadline, room_id, host_id
- **Room** _(retention: session)_ — A game room/lobby with settings and players
  - fields: room_id, host_id, max_players, initial_hand_size, join_link

## Integrations

- **Telegram** (required) — Bot API messaging
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Create and configure game rooms
- Join existing game rooms via invite link
- View and update private hand messages
- See public game state updates in the room

## Notifications

- Private hand updates when cards change
- Public game state updates after each action
- Turn timers with auto-actions on expiry
- Validation alerts for invalid moves

## Permissions & privacy

- Only players in a room can see its game state
- Private hand messages are only visible to the player
- Invite links are required to join rooms
- No personal data is stored beyond session

## Edge cases

- Players leaving mid-game
- Deck running out during draw phase
- Multiple players attempting to act simultaneously
- Invalid card plays during attack/defend/podkid phases

## Required tests

- Test room creation and join flow
- Validate full game cycle from start to end
- Test all rule enforcement scenarios
- Verify private/public message synchronization
- Test concurrency and race condition handling

## Assumptions

- Max players default to 6
- Initial hand size defaults to 6
- Telegram profile names are used for players
- 60s turn timers with auto-actions
- Server-side validation for all actions
