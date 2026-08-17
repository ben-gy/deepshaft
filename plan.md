# Game Plan: Deepshaft

## Overview
- **Name:** Deepshaft
- **Repo name:** deepshaft
- **Tagline:** A first-person descent into a mine that is closing behind you.
- **Genre (directory category):** arcade

Taken verbatim from the head of `IDEAS.md`'s big-game queue (the Doom-shaped entry).
A prior-art sweep of all 63 registry entries found no first-person game in the
fleet — `gloamrun` and `delvepack` are top-down crawlers, `sporeline` is a
tower-defence. This is the fleet's first raycaster.

## Core Loop
Take the cage down. Find the way to the next one, through a mine that is cut fresh
from a seed. Things live down here; some of them are asleep. The gun engages
whatever is awake in front of it, so the loop is *where you look, what you spend,
how loud you were* — and the tension is a triangle: three separate ammo pools with
no conversion between them, a noise budget where killing efficiently and killing
quietly are different skills, and a pressure clock that starts sending things after
you if you linger. Win by reaching the bottom (Adit, Lode) or by going as deep as
you can (Stope). Lose when everybody is down.

## Controls
- **Primary input:** touch. Considered and rejected: gyro tilt (a first-person view
  plus tilt-steering is nauseating and unplayable lying down) and microphone
  loudness (a shooter you have to shout at is a joke, not a mechanic). The last
  three registry entries are all tap-and-key, so the question was asked properly —
  the answer here is that the interesting problem in this genre *is* the touch
  scheme, and solving it is the contribution.
- **Desktop:** `W`/`S` walk, `A`/`D` strafe, `Q`/arrows turn, mouse yaw with
  pointer lock (requested on a click, with an edge-free absolute-steering fallback
  if denied), `E` use, `Tab`/`1`–`3` weapon, `Esc` pause.
- **Mobile:** ONE floating analog thumbstick (`@ben-gy/game-engine/joystick`),
  carrying **both** axes — forward/back walks, **left/right turns**, with a `|x|^1.6`
  curve so half a thumb-width is 25°/s for lining up a shot and full deflection is
  166°/s for spinning round. No strafe on touch, on purpose. No fire button —
  auto-fire makes aiming and firing the same act. USE appears only when something
  is usable. A second finger is an optional look-drag. Nothing sits in the middle
  56% of the screen, so reaching across the view is structurally impossible.

## Multiplayer
- **Mode:** live P2P.
- **Shape:** **co-op**. Versus was rejected on a specific technical ground rather
  than a preference: deathmatch is exactly the shape where 20Hz host-authoritative
  hurts most (symmetric, PvP, hitscan), and the industry fix — server-side rewind
  with favour-the-shooter — needs a *trusted* server. Ours is a player, so it
  degrades to favour-the-host, which is an unfixable fairness hole rather than a
  tuning problem. Co-op is asymmetric in the useful direction: the authoritative
  entities are AI, so a guest views enemies ~110ms in the past and is never shooting
  at a predicted human.
- **The opponent** is the difficulty curve: enemy count, mix, HP and damage all ramp
  per floor, and a pressure clock escalates if a floor drags. Players share one fate
  in the sense that the run ends on a full wipe, but an individual down is
  recoverable — 22s of bleed-out, 2.2s to revive at 1.1 cells. What stops one strong
  player soloing it is `partyScale`: the mine is bigger and busier per extra body.
- **Players:** 2–4. **Topology:** host-authoritative snapshot star at 20Hz, client
  input at 30Hz.
- **Room entry:** all three ways — scan the QR, open the invite link, type the code
  (the stock engine lobby provides all three).
- **Channels:** `snap` (host→all, ~700B binary at 20Hz), `in` (client→host, 6B at
  30Hz). **The map is never sent** — a floor is a pure function of
  `(seed, floor, mode, players)`, so one byte of floor number reproduces it exactly.
- **Host leaving:** the promoted peer already holds the geometry and the last
  snapshot; `Session.becomeHost()` adopts it and starts the clock. Wired through
  `onHostChange`.
- **Late joiner:** not in the frozen roster, so it renders the lobby's spectator
  state and is seated next run.

## End of round → rematch
`createRounds` from the engine. "Go again" is a vote plus a new round number; the
Net and the whole mesh stay up and the room is never left. While waiting, the
results screen shows `startsInMs` and the ready count, so a silent wait is
impossible. A peer who declines or closes the tab is dropped from the roster and the
countdown starts without them. If the **host** leaves on the results screen, the
promoted peer runs the rematch. "Back to the lobby" does not leave the room.

## Juice Plan
Procedural SFX per event (`src/cues.ts`), pitched by context — a kill is pitched by
the victim's size. Screen shake on damage and on a gas ignition. A damage veil
driven by a frame deadline (not a timeout — a background tab clamps those to a
second and the red wash sticks). Haptics on hits and cards. A 3-2-1-DOWN count-in on
the cage. Telegraphed enemy attacks with an audible tell.

## Style Direction
**Vibe:** retro-arcade, low internal resolution, deliberately pixelated upscale.
**Palette:** dark warm rock (`#4a3f36`, `#5a4632`, `#553a35`) with one cool wall
(`#3d4f5a`) so a worked seam is findable at a glance; self-lit high-chroma bodies
(`#ff9a3c`, `#56d8ff`, `#ff7ad1`, `#ffe066`). Every meaningful colour clears 3:1
against every surface, measured.
**Theme:** dark.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite.
- **Render:** Canvas 2D raycaster — column DDA, one `Uint32Array`, one
  `putImageData` per frame, ~170-column internal buffer upscaled by the compositor,
  fog as a 32-level lookup table.
- **Engine modules:** `loop`, `joystick`, `rng`, `sound`, `storage`, `mobile`,
  `identity`, `net`, `rematch`, `turn`, `lobby`.
- **Persistence:** localStorage — mute, mode, deepest floor per mode, tutorial seen.

## Non-Goals
Vertical geometry, a minimap, a level editor, deathmatch, more than four enemy
archetypes.

## Tutorial
Seven steps on a hand-cut floor, driving the **shipped** `Game`, movement, auto-fire
and firedamp. Restriction is a gate applied to the intent before it reaches
`tick()`; a refused axis is zeroed, never inverted. Runs on first visit before the
menu, skippable in one tap, replayable from "How to play".

1. **walk** — "Slide your thumb up to walk down the drift." (turn, fire, use refused)
2. **turn** — "Now slide left and right to look — the gallery turns south."
3. **shoot** — "Face the thrall. The gun fires on its own." A thrall is woken by the
   step itself; nothing in the mine is awake before the step that needs it.
4. **grate** — "The lurker is spitting through the grate. Walk on — it cannot follow."
5. **card** — "Take the amber card, then press USE at the amber door." (USE arrives here)
6. **damp** — "Some things are worth more where they are standing." **This is the
   step the game becomes interesting.** Kill them one at a time and it replays with
   the hint *"the pocket was the weapon"*.
7. **choice** — "The cage is right there. The carbide is two rooms back. Your call."
   **Both answers finish it and both are congratulated.** This is the step that
   turns an arena into a crawl.

Step 4 originally taught "walk past the sleeping one" and was **unpassable** — not
from a bug but because the rules are right and the lesson was wrong: a grate is
transparent, so the lurker sees you and wakes on its own, and a round aimed at the
thrall carries through the grate and wakes it anyway. Rather than bend two rules to
protect a sentence, the step now teaches what the geometry does.

## Frame budget
Target one frame at 60Hz = 16.7ms, split between simulation and raycaster.
**Measured:** simulation 0.053ms median / 0.080ms p95 per step with 121 bodies awake
on a 29×29 floor (Node, laptop — a regression guard, not a device number). Renderer
measured in-browser; see the build log. Pathing is one flow field per living player
every 6 ticks, so cost is O(cells) per 100ms regardless of horde size.

## How To Play (player-facing copy)
You never aim — the gun engages whatever is awake in front of you, so where you look
is what you shoot, and what you walk past stays asleep. One thumb: up and down walks,
left and right turns. Firedamp does not care whose side you are on. Take the cage
down; the mine gets worse every floor.
