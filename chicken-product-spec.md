# Chicken Dice Game: Product Spec

## Overview
A phone based app for playing Chicken as a group, with everyone's pot and scores synced live. Only the host installs anything, from Google Play. Everyone else joins from a browser, no install.

## Roles
- Host: creates the room, sets game options, plays as a normal player, and holds override controls.
- Player: joins via link or QR code, plays their turns, can chicken out at any time.

## Screens

### Host: create game
- Rounds: pick from 5 to 35.
- Starting rolls: pick from 1 to 5. Applies to every round.
- Dice mode: Physical or Virtual.
- Generates a room code and a QR code linking to the join page.

### Host: lobby
- Shows players as they join.
- Host arranges players into the turn order, the circle they'll play in. Defaults to join order, host can drag to reorder.
- Host taps Start Game once the order is set.

### Player: join game
- Scan the QR code or open the link.
- Enter a display name.
- Lands in the lobby, waiting for the host to start.

### Game screen (all players)
- Current pot total, shown large.
- Current round number and roll count within the round.
- Whose turn it is.
- Scoreboard: everyone's running total.
- Live event log: recent rolls, chicken outs, and busts.
- Chicken Out button, visible to every active player, disabled once you've chickened out this round.

**Waiting for your turn:** just the pot total and the Chicken Out button. Nothing else to do but watch and decide whether to chicken out.

**Your turn:** the roll input appears alongside the Chicken Out button, so you can chicken out before rolling or right after seeing your result.
- Physical mode: number grid 2 through 12, plus a double toggle enabled only for sums that can be doubles.
- Virtual mode: a single Roll Dice button with a short dice animation.
- The app tracks whether the round is still in its starting rolls or past them, so players never have to track that themselves.
- If your roll ends the round, the Chicken Out button disappears immediately, since the pot's already gone.

### Host controls panel
- Undo or edit the last roll.
- Remove or kick a player.
- Add a late player, joining at zero points, active starting next round.
- Reverse a chicken out ruling, either direction.

### End of game screen
- Final scoreboard, ranked.
- Option to start a new session with the same players and settings.
