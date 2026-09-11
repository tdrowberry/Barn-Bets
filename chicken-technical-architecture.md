# Chicken Dice Game: Technical Architecture

## Why this shape
The core hard problem is the bust versus chicken out race. That needs one server that decides event order, not phones talking straight to a shared database. Everything else follows from that.

## Stack
- Backend: Node.js with Socket.io. Holds each room's game state in memory and is the single source of truth.
- Frontend: a simple mobile first web app (plain HTML/JS or React), served as a page players open in their phone browser. The same codebase serves guests directly and gets wrapped for the host's install, details below.
- QR code: generated client side (a small JS library) from the room's join URL.

## Host app versus guest browser
Only the host needs to install anything. Guests scan the QR code or open the join link and it opens straight in their phone's browser, no download, no account. This works because the game's true state lives on the cloud server, not on any player's phone, host included. The host's device is just a client with extra permissions (host controls) and, if you want a Play Store listing, a wrapper around it.

This is the same shape as party games like Jackbox: one person runs the actual app, everyone else joins from a browser on their own phone.

- The host's installable app is the same web app wrapped for Google Play. A Trusted Web Activity is the lightest version of that wrapper, just your web page made installable.
- Ads only render on whatever device is running the actual app, which is the host's phone in this design. Guests, on plain browser tabs, see none. You still get paid, since ad networks pay per impression and click on the device that showed the ad, not per person in the room. Revenue is just tied to host sessions rather than total players.
- Two ways to run the ads:
  - Web based ads (Google AdSense or Ad Manager) rendered inside the page itself. Works cleanly inside a plain Trusted Web Activity, since that wrapper just renders your page, ad included. Same codebase either way, least setup.
  - Native ads (Google AdMob) inside a proper hybrid shell (something like Capacitor instead of a pure Trusted Web Activity), with a native ad banner docked around the web content rather than inside it. More setup, generally better fill rates and CPMs on mobile.
- Guests don't need any of this. Their join page stays a plain hosted web page, same as before.

## Hosting
- Render.com or Fly.io free tier both support the always on socket connection this needs.
- Tradeoff worth knowing: free tiers on these spin the server down after a period of no traffic, so the first connection after a break can take thirty to fifty seconds to wake up. Fine for a casual game night if the host starts the room a minute early. If that's annoying, a few dollars a month on a paid tier removes it.
- No database needed for the MVP. Game state lives in server memory for the session and disappears when it ends.

## Virtual dice mode: why the server rolls, not the phone
If the app generates the dice for you, that random number has to come from the server, not the current player's phone. Otherwise a player could tamper with their own client to force good rolls. Physical mode doesn't have this problem since the dice are real, but it does rely on players reporting their own roll honestly. Worth knowing as the tradeoff between the two modes.

## Data model (per room, in memory)

Room
- code, hostId, roundsTotal (5 to 35), startingRolls (1 to 5), diceMode (physical or virtual)
- currentRound, rollCountThisRound, pot, status (lobby, active, finished)
- turnOrder: ordered list of player ids, arranged by the host in the lobby before the game starts
- turnIndex: whose turn it is, wraps back to the start of turnOrder after the last player

Player
- id, name, totalScore, activeThisRound (false once chickened out), connected

Event (for the log and for resolving order)
- id, type (roll, chickenOut, bust, double, hostOverride, join, remove)
- playerId, payload, serverTimestamp

## Phase logic
A round is in its starting phase while rollCountThisRound is less than or equal to startingRolls. Once it passes that, a 7 busts the round. This makes startingRolls a configurable threshold rather than a hardcoded number.

## Turn order
Set once, by the host, in the lobby before the game starts. Defaults to join order, with drag to reorder. A player added mid session gets appended to the end and only enters rotation once the round in progress ends.

## Event flow
1. Client sends an action (roll, roll dice request, chicken out) to the server.
2. In virtual mode, the server generates the dice values itself on a roll request.
3. Server timestamps every action on arrival and processes actions strictly in that order.
4. Server applies game rules, updates room state, and broadcasts the new state to every client in the room.
5. Host override actions go through the same channel but are only accepted from the host's connection.

This means the resolution of a close bust versus chicken out is just whichever message the server got first, which is fair and doesn't depend on whose phone has a faster connection.
