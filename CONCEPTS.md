# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Deck store

### Deck store
The service that keeps Beta's decks behind Beta's login and serves each one unchanged at its own link. The link is how people and agents reach a stored deck; anyone signed in can open and edit any deck.

### Store tab
A browser tab showing a deck opened from the deck store rather than from a file. Its saves go back to the store in place.

### Conditional save
A save that names the version of the deck the tab holds and is refused when the store has moved on from that version.

Every save from a store tab is conditional. It exists so that a change made in the store while the deck is open is never overwritten silently.

### Latched tab
A store tab whose conditional save was refused. It sends no further saves until it is reloaded.

Its unsaved edits stay in the tab. After the reload they can be kept only as a new deck, never restored over the store's version, because the store's version is the change the refusal protected.

### Idle tab
A store tab that a reload would cost nothing: nothing unsaved, nothing being typed or drawn, no dialog waiting for an answer, no show running.

An idle tab reloads itself onto a newer store version. A tab that is not idle waits, and finds out through a refused save instead.

### Recovery snapshot
The browser-local copy of the last document a tab autosaved, offered back when the tab is reopened with something else loaded.

It is never kept for an encrypted deck. It describes what the tab last had, not what the store has, so a snapshot that predates a store change must not be restored over it.

## Who writes a stored deck

### Service write
A change to a stored deck made by an agent rather than by a signed-in person in the editor.

A service write does not travel through a live session, so tabs that have the deck open do not receive it; they learn of it from the store.

### Service generation
A counter the deck store keeps for each deck, raised by every service write and carried forward unchanged by a person's save.

It answers a question the deck's version alone cannot: whether an agent has written since the version a tab holds, even when a person saved last.

### Live tab
A store tab currently connected to its deck's live session, receiving collaborators' edits as they are made.

A live tab already holds a colleague's save before the store reports it, so a person's save is never a reason for it to reload. A service write is.

### Pairing
The exchange by which an agent that can hold no credential asks a signed-in person, once, for permission to publish as them.

### Grant
The short-lived permission a pairing produces. It lets an agent create decks and read or change a deck whose link it has, acting as the person who approved it; it cannot list the store or delete, and the person can end it early.

A write made with a grant is a service write.
