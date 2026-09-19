# Lighter Session Flow

## Entry

1. The user enters Lighter with `Light it up`, the desk shortcut, or the
   Lighter rail.
2. The runtime mode changes to `lighter` and the previous Agent or Studio
   selection is parked in `lighterReturn`.
3. The desk opens the Book rail and reads sessions filtered to
   `sessions.workspace = 'lighter'`.
4. If a Lighter session exists, the newest one is resumed. If none exists, the
   session creator opens once and is scoped to `workspace: 'lighter'`.

## Creation

1. The creator keeps the Lighter market title and optional first message.
2. It creates an Agent session with the Lighter workspace marker. Mission mode
   is unavailable in this surface.
3. The successful create transition activates the new session and remembers it
   as `lighterSessionId` before the chat rail mounts.
4. The first message is handed to that session once. Cancelling the creator
   does not reopen it automatically.

## Desk operation

- The chart, order book, ticket, approvals, and chat all use the same active
  Lighter session and market scope.
- Desk mutations go through the existing prepare and approval path. Opening the
  desk does not execute an order or change leverage.
- A market or environment change updates the desk scope; it does not create a
  second session.

## Exit and re-entry

1. Leaving Lighter restores the parked Agent or Studio session.
2. The current Lighter session is retained in `lighterSessionId`.
3. Re-entering Lighter resumes that session without creating a duplicate.
4. A failed session read leaves the creator closed and shows the read error;
   the app must not create a session from an unknown list state.

## Invariants

- Agent and Lighter sessions never share the same rail list.
- A newly created Lighter session is active before the initial chat hand-off.
- A cancelled empty-session prompt is not reopened in a loop.
- Returning to Agent never loses the previously active Agent session.
