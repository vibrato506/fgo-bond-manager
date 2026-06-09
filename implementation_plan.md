# Implementation Plan - Coronation Dual-CE support & Bond Math Engine Robustness

This plan introduces a major architectural upgrade to the **FGO Bond Manager**. We will transition from a purely AI-calculated bond model (which suffers from language model arithmetic limitations) to a **Hybrid Planning & Math Engine** model. The AI will design the party compositions and CE allocations, and the Javascript engine will mathematically calculate the exact bond points, ensuring 100% accuracy and complete adherence to FGO's mechanics (including the dual-CE friend support in Coronation battles).

---

## User Review Required

> [!IMPORTANT]
> **Key Architecture Change (Hybrid Engine)**:
> Currently, the AI attempts to calculate `perRunBond` and when to swap out servants itself. This is error-prone and often leads to the AI forgetting to apply the 20% trait-specific CEs or getting same-name servants mixed up.
> **We will change the AI to output structural allocations** (who is in which slot, which CE is equipped to each slot, and which 1 or 2 CEs are on the friend support). The Javascript code will then perform the **exact mathematical calculations** of the bond per run, remaining runs, and target completions. This guarantees **absolute mathematical correctness** and resolves the issue where trait-specific CEs were not being properly applied.

> [!TIP]
> **Full Owned Servant cataloging**:
> To resolve the issue where **Altria Caster (Berserker)** was not placed in slot 5 despite your instructions, we will send the AI a catalog of **all your owned servants** (with their IDs, classes, and traits) rather than only the unfinished target servants. This allows the AI to correctly identify and place non-target servants (like system loopers/supports) in slots as requested in your `編成備考 (notes)`.

---

## Proposed Changes

### 1. `app.js` (Core Engine)

#### [MODIFY] [app.js](file:///Users/shumairisawa/editor/fgo/fgo-bond-manager/app.js)
- **Extend `buildGeminiPrompt`**:
  - Retrieve and pass `ownedServantsInfo` (all owned servants, sorted/classified so the AI knows their exact IDs and classes, avoiding same-name confusion like Altria Caster (Caster) vs Altria Caster (Berserker)).
  - Pass detailed fixed CEs from the templates.
  - Explain the **Double CE Friend Support Rule** for Coronation (`戴冠戦`) battles:
    - If the quest name contains "戴冠戦", the friend support has **two** CEs.
    - These 2 CEs cannot be duplicates of each other, but they **can** duplicate with the player's own CEs.
    - If the quest name does not contain "戴冠戦", the friend support has **one** CE.
  - Explain the **Own CE uniqueness rule**: The player's own 5 slots can equip at most 1 CE each, and no duplicates are allowed among the own CEs.
  - Refine the JSON output schema so the AI returns:
    - `party`: list of 5 servant IDs/names for the slots.
    - `partyCEs`: array of 5 CE IDs (e.g. `teatime`, `lunchtime`, `kyokuten`, `portrait`, `trait_秩序かつ善`, `none`) representing what each of the 5 own slots equips.
    - `friendCEs`: array of 1 or 2 CE IDs representing what the friend support equips.
    - `partyBonus`: array of 5 numbers representing the slot placement multipliers (e.g., `1.24`, `1.04`, `1.0`) parsed from the notes.
    - `runs`: estimated number of runs.

- **Upgrade output processing in `runScheduleSimulation`**:
  - Intercept the AI JSON.
  - Recalculate **each servant's `perRunBond` mathematically** using the same formulas as the UI cost/bond calculator, based on:
    - Base bond and teapot toggle (`useTeapot`) of the battle template.
    - Slot placement multiplier (`partyBonus`).
    - Equipped own CE in the slot (`partyCEs`).
    - Equipped friend CE(s) (`friendCEs`).
    - Servant's class and active traits (matching any trait-specific 20% CEs).
  - Verify and calculate when a servant is `completed` (reaches their target bond level) based on actual JS math rather than AI's estimation.
  - Build highly descriptive labels for the UI to display the exact CE allocated to each servant!

---

### 2. `index.html` (User Interface)

#### [MODIFY] [index.html](file:///Users/shumairisawa/editor/fgo/fgo-bond-manager/index.html)
- Upgrade the **Phase Card UI** to visually show the equipped CE for each servant in the party!
  - Under each servant's name in the party card, display a premium-looking badge indicating their equipped CE (e.g., "ランチタイム", "20%特攻: 秩序かつ善", or "礼装なし").
  - Render a clear **Friend Support section** next to the party cards, displaying the friend servant's CE(s) (1 or 2 badges depending on whether it's a Coronation battle).
  - This visual representation will make it extremely easy to copy the setup directly into the game!

---

## Verification Plan

### Automated/Code Validation
- Ensure Vue.js state remains reactive.
- Test that Coronation battles correctly allocate 2 friend CEs without duplicate errors.
- Ensure same-name servants have different IDs in the payload, and are mapped correctly.

### Manual Verification
1. Create a Coronation battle (containing "戴冠戦" in the name) and run the chart generation.
2. Verify that:
   - Slot 5 instructions (like placing Altria Caster Berserker) are strictly followed.
   - The 20% CEs for "秩序かつ善" and "秩序かつ女性" are automatically selected and applied to servants matching those traits (like Jeanne).
   - The math is completely correct and matches the game calculations.
   - The UI displays the equipped CEs beautifully.
