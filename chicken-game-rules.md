# Chicken Dice Game: Rules Spec

## Setup
- Each round, two dice are rolled by whoever's turn it is.
- Players join a game room. Before the game starts, the host arranges them into a turn order. Play moves through that order in a circle, looping back to the first player after the last.
- The host also configures three settings before starting:
  - Rounds: how many rounds make up the session. Choose any number from 5 to 35.
  - Starting rolls: how many rolls at the start of each round are safe from a bust. Choose 1 to 5. This applies the same way to every round in the session.
  - Dice mode: Physical (players roll their own dice and report the result) or Virtual (the app rolls for you).

## Rolling

### Physical mode
- On your turn, report your two dice.
- Tap the number matching the sum of your two dice (2 through 12).
- If both dice show the same value, also tap Double. Only sums 2, 4, 6, 8, 10, and 12 can be doubles, since two dice can't make an odd sum with matching faces.

### Virtual mode
- On your turn, tap Roll Dice.
- The app generates the roll for you, on the server rather than your phone so it can't be tampered with, and applies the sum and double automatically.

In both modes, turn passes to the next active player after every roll.

## Starting rolls phase
Covers the first N rolls of the round, where N is the starting rolls setting the host picked (1 to 5).
- Roll a 7: add 70 to the pot.
- Roll a double: add the sum to the pot. Doubles don't double the pot yet.
- Roll anything else: add the sum to the pot.

## After the starting rolls
Once the round has had more rolls than the starting rolls setting:
- Roll a 7: the round ends immediately. Pot drops to zero. Anyone still active gets nothing from this round.
- Roll a double: the pot doubles.
- Roll anything else: add the sum to the pot.

## Chickening out
- Any active player can tap Chicken Out at any point during the round, whether it's their turn or not.
- Chickening out adds the current pot total to that player's running score.
- On your own turn, you can chicken out either before you roll, skipping your roll for that turn, or right after you roll and see the result. The only exception is a roll that ends the round: once that happens the pot is already gone, so there's nothing left to chicken out into.
- Once you chicken out, you're inactive for the rest of the round. You can't roll or chicken out again until the next round starts.

## When a round ends
- A bust (a 7 rolled after the starting rolls) ends the round. Pot resets to zero.
- If every player chickens out before a bust, the round ends right there too. Everyone keeps what they already locked in by chickening out. The remaining pot is discarded. The next round starts.
- The next round starts with the next player in turn order after whoever busted (or after the last player, if everyone chickened out). All players go active again. Roll count resets to zero.

## Adding a player mid session
- The host can add a player at any time. They start at zero points.
- They join the turn rotation at the start of the next round, not mid round, since dropping someone into a round already in progress has no clean position for them.

## Ending the game
- After the host's chosen number of rounds, the session ends.
- Highest total score across all rounds wins.

## Bust versus chicken out at the same moment
- Every action (roll, chicken out) goes to the server, which stamps it with the order it arrived.
- If the server processes a bust before a given chicken out request arrives, that request is automatically rejected. Too late.
- If a chicken out request arrives before the bust, it's automatically accepted, even if the round ending 7 was rolled a split second earlier on someone else's screen.
- The host can reverse either outcome after the fact if something looks wrong.
- A live event log is visible to everyone so disputes have a paper trail.
