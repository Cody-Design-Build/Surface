# Haunted House Repairs Game Plan

**Status:** Possible game concept for prototyping, not a committed production project.
**Working title:** Haunted House Repairs.
**Created:** October 20, 2026.

You are a maintenance worker trying to finish ordinary repairs in a haunted house. Each repair requires repeated material deliveries, followed by work with the right tool at the repair site. A ghost interrupts both stages. When it approaches, you must abandon the job and escape or die.

The intended experience is frantic, funny movement through the house: discovering jobs, collecting supplies, choosing what to carry, forgetting where you left a tool, and trying to finish just a little more work before running away. The central temptation is: **“I can finish this before it gets here.”**

This repository holds the concept document. It does not make the game part of Surface or commit the prototype to Surface's technology stack.

## The player objective

Complete enough repairs to finish your shift, then get back to the van alive. Start with a short, replayable session in one house. Give the player several available jobs and some choice about their order, so they can combine deliveries or switch jobs when the ghost makes one route dangerous.

The house should feel like a workplace becoming increasingly difficult to work in. The repairs remain mundane even when the situation is ridiculous. You might be fleeing for your life because the upstairs towel rail still needs two screws.

Start with one player. Cooperative play could amplify the comedy later, but the solo loop should work before networking, team roles, or coordination become part of the scope.

## The repair loop

1. Inspect a broken fixture. Inspection adds a job to the clipboard and reveals its material list and required tool.
2. Find supplies in the house or at the van. Decide whether to carry more material, bring a tool, or combine errands for different jobs.
3. Deliver materials to the marked repair site. Each accepted bundle fills part of its material bar.
4. Once the materials are complete, equip the required tool and begin work at the fixture.
5. Hold the work input to fill the work bar. Working occupies your hands and makes noise.
6. When you hear or see the ghost approaching, release the input and run. Drop an awkward item if you need to escape more easily.
7. Break the chase, recover what you left behind, and return to the unfinished repair or tackle another job.
8. Finish the shift's repair quota and reach the van.

The player can interrupt work immediately. A long animation must never prevent the escape that the controls appear to promise.

## Two bars with different jobs

| Stage | How progress increases | What interruption does | What the player decides |
|---|---|---|---|
| Materials delivered | Correct bundles reach the site's delivery zone | Delivered materials remain there; carried supplies can be dropped and recovered | What to carry, where to fetch it, and which route to take |
| Work completed | Player stays at the fixture, holds the work input, and has the required tool | Completed work remains; progress stops immediately when the player leaves | How long to risk staying and when to flee |

Material progress represents actual deliveries. It does not fill just because the player waits nearby. Depositing a valid bundle should be quick; the second bar provides the sustained exposure at the work site.

Show both bars on the fixture and summarize them on the clipboard. A job can read **Materials 2/3 · Work 0%**, then **Materials 3/3 · Work 65%**. Make the distinction readable at a glance.

Use these job states: **Undiscovered → Gathering → Ready to work → In progress → Complete.** A chase does not move the job backward. Death ends the current run; ordinary escapes preserve its progress.

## Carrying and tool rules

Begin with two carrying slots. A small material bundle takes one slot, a bulky object takes both, and a tool takes one. Keeping a wrench with you makes some deliveries less efficient; leaving it at the job frees your hands but creates a later retrieval problem.

Keep the controls forgiving. Items have clear pickup targets, dropping is immediate, and valid deliveries snap into the site's supply area. Wrong materials receive a short explanation and remain recoverable. Supplies must not disappear because the player dropped them near the wrong job.

Awkward objects create readable disadvantages. A ladder needs wider turns. A large cistern obscures part of the view. A loose bucket rattles while running. The player should be able to recognize the problem and choose to drop the item, rather than wrestle with unpredictable collision physics.

Dropped tools stay where they land. The clipboard can show their last known room to avoid turning every interruption into a frustrating search. Delivered materials are never stolen or reset in the first prototype.

## The ghost and the escape

The ghost patrols the house, investigates noise, pursues the player when it finds them, and eventually loses the chase. Working with a loud tool attracts it more strongly than ordinary walking. Sprinting helps escape but also makes noise.

Approach cues should give the player a decision window: footsteps in the hall, a door opening, a shadow, or a change in nearby sound. A loud drill can make footsteps harder to hear, but the player still needs another perceptible cue before an unavoidable encounter.

Being caught kills the player. Make that consequence fair through a readable approach and a brief, recognizable attack windup. Avoid spawning the ghost directly behind the player or killing them during an uninterruptible work animation.

For the prototype, escape means breaking line of sight and changing position while the ghost investigates the last known location. Use a house with loops, connecting rooms, and more than one way around a dangerous hallway. A hiding system can wait until chasing and losing the player are already enjoyable.

The ghost must leave unsuccessful searches and resume moving. It should not permanently camp the only unfinished fixture. Route knowledge and good decisions need to create real escape opportunities.

## Where the comedy comes from

The joke is the collision between ordinary maintenance and immediate supernatural danger. The player's actions should create most of it.

| Situation | Playable complication | Comic result |
|---|---|---|
| Carrying a ladder upstairs | Wide turns and a partly blocked view | A desperate escape becomes a three-point turn on the landing |
| Repairing a toilet | A bulky replacement part uses both slots | The player flees through the lounge carrying a cistern |
| Finishing a noisy job | Tool noise draws an investigation | The drill stops and the player suddenly hears footsteps very close by |
| Dropping supplies in a panic | Recoverable items scatter within a small area | The player returns to collect the screws they abandoned on the stairs |
| Leaving a tool at another job | Tool location persists | The apparently sensible shortcut turns into another trip through the haunted hallway |

Keep exaggerated sound, object poses, and small physical mishaps clear enough that the player understands what happened. Avoid unpredictable controls that make the player feel cheated. A sarcastic job description or completion stamp can support the joke, but repeated dialogue should not carry it.

## Example repair

**Job: Replace the upstairs toilet cistern.**

The player inspects the toilet and learns it needs three bundles: a pipe kit, sealant, and a replacement cistern. The wrench is downstairs. The pipe kit and sealant each take one slot; the cistern takes both. Each delivered bundle contributes one third of the material bar.

The player delivers the two small bundles together, returns for the cistern, and then fetches the wrench. With all three bundles delivered, work begins. Use 16 seconds of uninterrupted work as an initial tuning value.

At roughly halfway, the wrenching noise draws the ghost toward the bathroom. The player tries to finish another few seconds, hears the hallway door, and runs. The work bar stops where it is. The ghost chases them through a connecting bedroom and loses them near the kitchen.

Now the player has a choice: return upstairs to finish, collect material for a different job while the ghost is nearby, or recover a tool dropped during the chase. That choice is the loop the prototype needs to prove.

## Making repeated trips interesting

Repeated delivery is the structure of the game, so trips need changing circumstances. Use different combinations of supply locations, bulky items, tool requirements, and ghost routes. Let experienced players improve their route and combine errands.

Begin with a fixed house layout so players can learn it. Shuffle a limited set of repair and supply placements between runs, with checks that all supplies are reachable and sufficient for the available jobs. Let repairing something occasionally change a route or reduce a nuisance, such as fixing a door that otherwise sticks.

Avoid filling out the game by increasing every material quantity. If a trip presents no new choice or complication, shorten it or remove it. Also avoid a permanently safe supply room that lets the player trivialize every chase from the same doorway.

The year-round premise is a haunted maintenance shift. Halloween decorations or a seasonal event could be added later; the repair, carrying, and chase systems should be entertaining without them.

## Smallest playable prototype

Use placeholder art and sound. Start with the toilet repair above, one ghost, and a compact house route linking the supply area, stairs, bathroom, and a connecting room. Include an alternate path so escape is possible. The first complete run only needs one repair and a return to the van.

Initial tuning values are design hypotheses to test, not production targets:

| Item | Starting value |
|---|---|
| Player capacity | Two slots |
| Repair supplies | Three bundles, including one bulky object |
| Work time | 16 seconds, accumulated across attempts |
| Work tools | One wrench |
| Pursuer | One ghost with patrol, investigate, chase, and search behavior |
| Session length | Aim for roughly five minutes |
| Expected interruption | At least one readable chance to abandon work and escape |

Build the prototype in this order:

1. **Delivery:** movement, pickup, carrying capacity, dropping, site deposits, and the material bar. Check that bulky carrying is funny without making navigation unreliable.
2. **Work:** tool requirement, work position, held input, accumulated progress, and immediate cancellation when the player moves.
3. **Threat:** ghost navigation, investigation of work noise, approach cues, pursuit, loss of contact, and death/retry.
4. **A complete shift:** clipboard, fixture inspection, job completion, return to the van, and a quick restart after failure.
5. **Variety test:** add a squeaky-door job and a leaking-sink job, then ask the player to complete two of the three. Test route planning before adding a larger house.

Choose the engine, perspective, and art style when starting the prototype. A first-person prototype is the initial suggestion because obstructed views and nearby sounds can support the carrying and pursuit decisions. Compare another perspective only if it makes movement or object comedy substantially clearer.

## Playtest decisions

Observe players rather than explaining the intended joke. Record rough delivery counts, chase outcomes, abandoned work attempts, and where players become lost or stuck. Ask which moments felt funny, tense, or tedious.

Continue developing the concept if players understand both bars, voluntarily risk a little more work, use more than one escape route, and want another attempt after being caught. Look for funny incidents caused by their own decisions rather than scripted scares alone.

Rework the loop if players only tolerate the supply runs to reach a chase, cannot tell why the ghost found them, or repeatedly blame the controls. If players always finish work before a meaningful threat, adjust noise and investigation timing. If they never have time to make progress, increase the escape window or reduce exposure.

Expand only after the small loop works. Multiplayer, procedural houses, many ghost types, detailed crafting, upgrade shops, extensive lore, and seasonal content can wait. The first milestone is one ordinary repair that becomes a funny story because the player had to abandon it and run.
