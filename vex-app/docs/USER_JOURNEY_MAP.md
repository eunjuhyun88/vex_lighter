# Vex User Journey Map

**Status:** Current journey inventory
**Updated:** 2026-09-19
**Scope:** Desktop launch, onboarding, Agent, Studio, Lighter, approvals, account setup, recovery, and maintenance.

This document describes the journeys a person can take through Vex. It is an experience map, not an implementation proposal. Every journey includes the user goal, visible steps, runtime work, completion signal, and the next safe action when the path is blocked.

## 1. Journey model

Every journey is described with the same six checkpoints:

1. **Entry** - what the person sees or does first.
2. **Intent** - what they are trying to accomplish.
3. **Interaction** - the visible steps and decisions.
4. **Runtime** - the main process, database, provider, or external service work.
5. **Completion** - the evidence that the goal is complete.
6. **Recovery** - the one safe next action for each blocked state.

The product has four user-facing surfaces:

| Surface | Primary object | Main user goal |
| --- | --- | --- |
| Launch and setup | Local machine and encrypted vault | Make Vex ready to use |
| Agent | Conversation and session | Ask, research, and approve actions |
| Studio | Project and workspace | Build, inspect, and run strategies |
| Lighter | Market, ticket, order, and trading session | Understand a market and review a trade |

## 2. Journey index

| ID | Journey | Primary outcome |
| --- | --- | --- |
| J-01 | First launch and machine readiness | Vex reaches setup or the app shell |
| J-02 | Returning launch and unlock | Existing installation opens safely |
| J-03 | First-time setup | Vault, wallet, provider, and agent are configured |
| J-04 | Agent conversation | A user gets an answer or a proposed action |
| J-05 | Session management | Sessions can be created, resumed, organized, and exported |
| J-06 | Mission execution | A longer goal runs with pause, resume, and approval gates |
| J-07 | Approval and action execution | A proposed action is explicitly confirmed and proven |
| J-08 | Lighter discovery and market analysis | A user enters Lighter and forms a market view |
| J-09 | Lighter account setup | A trading account becomes readable and ready |
| J-10 | Lighter order lifecycle | A trade moves from draft to provider outcome |
| J-11 | Lighter position protection | A verified fill receives a separate protection order |
| J-12 | Lighter leverage change | A whole-number leverage change is applied and reconciled |
| J-13 | Studio project work | A project is opened, edited, run, and inspected |
| J-14 | Portfolio and asset review | Wallets, balances, assets, and history are inspected |
| J-15 | Settings and credentials | Configuration is changed and reflected in the app |
| J-16 | Update and maintenance | The app is updated or repaired without losing state |

## 3. J-01 - First launch and machine readiness

```text
Open Vex
 -> launch gate probes system, Docker, and setup state
 -> system check
 -> Docker remediation
 -> Compose services
 -> database migrations
 -> setup wizard
```

**User intent:** Start using Vex on a new machine.

**Visible states:**

- Waking the desk
- Starting services
- Preparing the ledger
- Reading setup
- Ready

**Runtime work:** `system.health`, `docker.detect`, `onboarding.getEnvState`, Compose startup, migration progress, and wizard state resolution.

**Completion evidence:** The user reaches either the setup wizard or the unlocked app shell. The launch gate never hides a failed prerequisite without handing off to the screen that can repair it.

**Recovery:**

- Docker unavailable: open Docker setup and show the exact remediation.
- Compose port collision: identify the conflicting Vex service and retry after cleanup.
- Migration failure: keep the migration screen open and preserve progress.
- Unreadable setup state: route to system check instead of guessing.

## 4. J-02 - Returning launch and unlock

```text
Open Vex
 -> verify existing setup
 -> verify Docker and services
 -> reuse or start Compose
 -> read migrations and wizard state
 -> unlock vault if required
 -> open Agent, Studio, or the persisted safe destination
```

**User intent:** Continue where they left off without exposing keys or stale runtime state.

**Completion evidence:** The vault is unlocked, the database is usable, and the user reaches the shell. A persisted Studio location may be restored. Lighter is entered by an explicit action rather than resumed automatically.

**Recovery:** A locked vault opens `Unlock`; a missing vault reopens the keystore step; a stale project falls back to Studio welcome; a service failure returns to the relevant remediation screen.

## 5. J-03 - First-time setup

```text
System check
 -> Keystore
 -> Wallets
 -> API keys
 -> Embedding
 -> Provider and model
 -> Agent Core
 -> Review and finalize
 -> Unlock
 -> Agent shell
```

**User intent:** Configure a usable local agent without losing progress.

**Runtime work:** Each step validates through a typed IPC contract and persists only the required configuration. Wallet selection is resolved in the main process.

**Completion evidence:** Setup state is `completed`, the vault exists, the selected provider is readable, and the first Agent session can be created.

**Recovery:** A failed step stays on that step with retry or edit. If the vault exists but is locked, unlock before resuming the wizard.

## 6. J-04 - Agent conversation

```text
Choose or create a session
 -> write a message
 -> submit
 -> stream the response
 -> inspect tool activity
 -> read the answer or review an approval
```

**User intent:** Ask a question, research a market, or ask Vex to prepare an action.

**Runtime work:** `vex.chat.submit` validates the session, persists a mission goal when needed, ensures the engine database is ready, and enters the canonical agent runtime.

**Completion states:**

- Answer complete
- Tool result complete
- Approval waiting
- Engine error with retry
- Stop requested

**In-flight controls:** Stop, queue, edit queued text, send now, steer, and retry.

**Recovery:** A missing session is surfaced as a session error. A provider or database failure keeps the conversation available and gives retry rather than silently dropping the message.

## 7. J-05 - Session management

```text
Open session library or sidebar
 -> create, select, search, filter, pin, rename, branch, export, or delete
 -> return to the selected session
```

**User intent:** Keep conversations organized and recover previous work.

**Runtime work:** Session CRUD, wallet scope validation, mission companion rows, transcript reads, and Markdown export.

**Completion evidence:** The sidebar and active center agree on the same session identity and workspace scope.

**Recovery:** Invalid wallet selection prevents creation. A deleted or stale selection is cleared instead of opening a different session by accident.

## 8. J-06 - Mission execution

```text
Create Mission session
 -> describe the goal
 -> accept or edit the mission contract
 -> start execution
 -> observe turns and approvals
 -> pause, resume, retry, renew, or stop
 -> inspect final result
```

**User intent:** Run a longer bounded objective with explicit control.

**Runtime work:** Mission draft, contract acceptance, engine dispatch, run status, launch ceilings, auto-retry, and mission lifecycle recovery.

**Completion evidence:** The mission is completed, stopped, or clearly blocked with a durable status and a next action.

**Recovery:** A paused run offers resume; a failed run offers retry when safe; a terminated run cannot be resumed as if it were active.

## 9. J-07 - Approval and action execution

```text
Agent or desk prepares an action
 -> approval card appears
 -> user reviews exact terms
 -> Confirm or Reject
 -> main process dispatches
 -> provider evidence is read
 -> final result is shown
```

**User intent:** Decide whether a proposed state-changing action should happen.

**Runtime work:** Approval repository compare-and-set, intent decision, dispatch, settlement, transcript mapping, and recovery sweep.

**Completion evidence:** The UI distinguishes approved, rejected, submitted, confirmed, failed, canceled, and unknown outcomes.

**Recovery:** Unknown outcomes instruct the user to refresh the relevant activity before retrying. Restart recovery reconciles interrupted dispatches without creating a second action.

## 10. J-08 - Lighter discovery and market analysis

```text
Click the permanent Lighter entry
 or type "light it up"
 -> enter the Lighter desk
 -> select Core or RHC in the market picker
 -> select market, product, and interval
 -> inspect chart, book, trades, and account context
 -> open Vex
 -> ask for analysis or a plan
```

**User intent:** Understand the visible market before deciding whether to trade.

**Runtime work:** Public market streams, candle history, account snapshot polling, scoped prompt context, and Lighter session handoff.

**Completion evidence:** The selected environment and market are visible in the header, the data is live or explicitly marked stale, and the Vex prompt is scoped to the same market.

**Recovery:** A disconnected stream shows reconnecting state. A missing market list keeps the picker actionable. A closed Vex rail exposes one `Open Vex` control.

## 11. J-09 - Lighter account setup

```text
Open Lighter
 -> read setup checklist
 -> deposit if needed
 -> wait for provider credit
 -> create or confirm trading key
 -> approve fee capability
 -> check setup again
 -> read account and balances
```

**User intent:** Make the selected Lighter environment ready for safe order preparation.

**Completion evidence:** The checklist is `ready`, account reads are available, and the ticket can size against live inventory or margin terms.

**Recovery:** The checklist reports `in_progress`, `action_required`, `needs_reconciliation`, or `failed` with one specific next action.

## 12. J-10 - Lighter order lifecycle

```text
Draft ticket
 -> choose product and side
 -> enter size, price, leverage, and protections
 -> validate balance, inventory, fee, price, and minimums
 -> review with Vex if desired
 -> Prepare Long/Short or Buy/Sell
 -> Approval card
 -> Confirm
 -> provider submission
 -> exact order tracking
 -> open, partial, filled, rejected, canceled, or unknown
```

**User intent:** Place one deliberate order with visible terms and a provable outcome.

**Runtime work:** Main derives authoritative terms from the strict selector, validates the Lighter workspace, prevents duplicate in-flight preparation, signs only after confirmation, and correlates results by provider order ID.

**Completion evidence:** Orders show the exact provider identity and state. Partial fills remain open until the remainder reaches a terminal state.

**Recovery:** Accepted but unsettled orders say not to retry. Unknown orders require an Orders refresh. Rejected and canceled states remain distinct.

## 13. J-11 - Lighter position protection

```text
Observe verified fill
 -> read exact filled amount
 -> load protection values
 -> review TP/SL order
 -> Prepare protection
 -> Approval
 -> Confirm
 -> track protection order
```

**User intent:** Protect the position using the amount that actually filled.

**Runtime work:** Exact fill aggregation, side inversion, trigger validation, protection sizing, and a separate approval path.

**Completion evidence:** Protection is linked to the verified fill and does not use the originally requested amount when the order only partially filled.

## 14. J-12 - Lighter leverage change

```text
Open Settings > Lighter
 -> choose market
 -> enter a whole-number multiplier
 -> prepare proposal
 -> review confirmation modal
 -> Confirm
 -> sign and submit through main
 -> read provider state
 -> refresh account, limits, and overview
```

**User intent:** Change leverage for one market and see the confirmed result.

**Completion evidence:** The displayed multiplier is an integer such as `10x`, provider state matches the target, and dependent reads are invalidated.

**Recovery:** Cancel, expire, supersede, refusal, and reconciliation-required states are shown explicitly. No live transaction should be assumed from a prepared proposal.

## 15. J-13 - Studio project work

```text
Switch Agent to Studio
 -> create or select project
 -> browse files
 -> open terminal
 -> connect external MCP agent
 -> edit or search files
 -> run local strategy
 -> inspect output
 -> import, publish, or return to Agent
```

**User intent:** Build and inspect a strategy workspace with an external coding agent.

**Runtime work:** Project CRUD, scoped files, terminal input, bridge readiness, local runtime, AgentScan import, and publication.

**Completion evidence:** The project remains selected, file and terminal state are scoped to it, and any published or imported artifact has a visible status.

**Recovery:** A missing project returns to Studio welcome. File mutation and terminal errors stay inside the project boundary.

## 16. J-14 - Portfolio and asset review

```text
Open BOOK rail
 -> inspect portfolio, wallets, balances, or activity
 -> open All Assets
 -> open a token row
 -> inspect token history
 -> close back to the original scope
```

**User intent:** Review holdings and activity without losing the current session or project scope.

**Runtime work:** Portfolio reads, wallet scope, asset aggregation, AgentScan scope, token history, and route return state.

**Completion evidence:** Global, session, and project scopes stay distinct when navigating deeper and returning.

## 17. J-15 - Settings and credentials

```text
Open profile or contextual Settings link
 -> choose a section
 -> edit configuration
 -> validate in main
 -> persist
 -> invalidate the affected reads
 -> return to the original surface
```

**User intent:** Change how Vex connects, reasons, stores keys, or trades.

**Completion evidence:** The new value is reflected by the next read and the original surface does not silently retain stale data.

**Sensitive areas:** Vault, wallet export, API keys, provider credentials, Lighter trading credentials, chain endpoints, and leverage.

## 18. J-16 - Update and maintenance

```text
Update available
 -> review update notice
 -> download
 -> restart when ready
 -> verify signed package
 -> restart launch pipeline
```

Maintenance paths also include Docker restart, Compose retry, migration retry, database reconnect, stream reconnect, and provider reconciliation.

**Completion evidence:** The user sees one durable status and a concrete next action. Sensitive state is not exposed in error copy or update UI.

## 19. Cross-journey rules

These rules apply to every journey:

- The visible environment, market, session, project, and wallet scope must match the backend scope.
- A state-changing action must show its exact terms before confirmation.
- Renderer code selects intent; the main process derives and validates authoritative terms.
- Unknown provider outcomes must never be presented as success or failure without evidence.
- Every blocked state needs one safe next action.
- Sidebar, Vex rail, chart, ticket, and account dock resize independently without hiding the primary action.
- Closing a screen returns to the scope that opened it.
- Reduced motion preserves state communication without moving critical controls.
- Live account or trading behavior is not proven by unit tests alone; a separately authorized canary is required.

## 20. Acceptance matrix for the next review

The next product review should run these journeys in order:

1. First launch through a usable Agent session.
2. Returning launch with a locked vault.
3. Agent message through approval and rejection.
4. Agent message through approval and confirmed provider result.
5. `light it up` through Lighter session creation.
6. Lighter setup incomplete, in progress, ready, and recovery states.
7. Lighter ticket through approval, exact order tracking, partial fill, and protection.
8. Leverage proposal through confirm, provider read-back, and canceled proposal.
9. Studio project through file, terminal, strategy run, and return to Agent.
10. Portfolio scope through token history and back.
11. Settings change through dependent UI refresh.
12. Update, restart, and recovery after a service interruption.

Each review record should capture:

- Entry surface and viewport size
- User action
- Visible state change
- IPC call and result kind
- Database/provider state change
- Completion evidence
- Failure copy and next action
- Whether the path is safe to retry

