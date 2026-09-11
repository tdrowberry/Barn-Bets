# Chicken Dice Game: Build Plan for Claude Code

Feed this alongside the rules spec, product spec, and architecture doc. Suggested build order, each phase should be working and testable before moving on.

## Phase 1: Rooms and joining
- Node and Socket.io server scaffold.
- Host can create a room, choosing rounds (5 to 35), starting rolls (1 to 5), and dice mode (physical or virtual).
- QR code and join link generation.
- Players can join with a name, lobby screen shows who's in.
- Host arranges turn order in the lobby before starting, defaulting to join order with drag to reorder.

## Phase 2: Core roll logic
- Turn order and whose turn indicator.
- Two screen states: waiting (pot and Chicken Out only) and your turn (roll input plus Chicken Out, available before or after rolling).
- Physical mode: number grid input plus double toggle.
- Virtual mode: Roll Dice button, server generates the roll.
- Server side pot math using the room's startingRolls setting to decide starting phase versus bust phase.

## Phase 3: Chickening out and the race condition
- Chicken Out button, server side ordering of roll and chicken out events.
- Automatic accept or reject logic based on arrival order.
- Live event log visible to all players.

## Phase 4: Host controls
- Undo last roll.
- Remove or kick a player.
- Add a late player at zero points, active next round.
- Reverse a chicken out ruling.

## Phase 5: Round and session flow
- Round end and reset logic, including the all chickened out edge case.
- Session end after the configured round count, and final leaderboard.

## Phase 6: Polish, ads, and deploy
- Mobile styling pass for both dice modes.
- Deploy the web app to Render or Fly. This is the whole guest experience, plain browser, no install.
- Wrap the same web app for the host as an installable Google Play app. Decide web based ads (simplest, same codebase, works in a plain Trusted Web Activity) versus native AdMob (a Capacitor style hybrid shell instead) before building this piece, since it changes which wrapper you need.
- Test with several phones on the same room at once, specifically testing the bust versus chicken out timing in both dice modes.
