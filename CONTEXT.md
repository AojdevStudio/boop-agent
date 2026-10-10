# Boop Personal Agent

Boop is a personal agent that communicates with the user through messaging channels and delegates tool work to focused execution agents. This context captures the product language for messaging, memory, drafts, and integrations.

## Language

**Local Messages Integration**:
A local macOS integration that gives execution agents access to the user’s real Messages.app inbox through the local Messages database and Messages.app automation.
_Avoid_: iMessage Inbox, Text Inbox, Sendblue Integration

**Sendblue Thread**:
The external iMessage/SMS conversation between the user and Boop’s Sendblue-provisioned number.
_Avoid_: Local Messages inbox, personal inbox

**Execution Agent**:
A focused worker agent spawned to perform a specific task with scoped tools or integrations.
_Avoid_: Sub-agent when discussing product behavior

**Interaction Agent**:
The front-door dispatcher that receives the user’s message, manages memory/drafts/automations, and decides whether to spawn an **Execution Agent**.
_Avoid_: Main model, chatbot

**Draft**:
A persisted pending external action that must be reviewed before it is committed.
_Avoid_: Sent message, queued send

**Approval Gate**:
A hard user-confirmation step required immediately before an externally visible action is executed, represented by an explicit user confirmation and a backend approval token.
_Avoid_: Prompt instruction, soft confirmation

**Approval Token**:
A short-lived backend record proving the user approved one exact draft payload for sending.
_Avoid_: Confirmation text, model promise

**Broad Read**:
A Local Messages read operation that scans across multiple chats, searches the full inbox, or watches a chat continuously rather than answering from one clearly requested conversation.
_Avoid_: Normal read, search

**Message Metadata**:
Non-content audit data about a Local Messages tool call, such as tool name, target chat/contact, date range, message count, and result count.
_Avoid_: Message content, transcript

**One-Shot Watch**:
A bounded Local Messages watch operation that streams new messages from one chat for a fixed timeout and then stops automatically.
_Avoid_: Background watcher, daemon, subscription

**User-Initiated Message Access**:
Local Messages access that occurs only in response to a direct user request in the current conversation.
_Avoid_: Automation scan, proactive inbox monitor

**Recipient Candidate**:
A possible 1:1 Messages destination or source found while resolving a name, phone number, email, or chat.
_Avoid_: Recipient when ambiguous

**Memory**:
A durable fact about the user stored by Boop for future recall.
_Avoid_: Chat history, model memory

## Relationships

- An **Interaction Agent** may spawn one or more **Execution Agents**.
- An **Execution Agent** may use the **Local Messages Integration** when explicitly granted that integration for a task.
- The **Local Messages Integration** can read the full local Messages.app inbox for personal use by wrapping the existing local `imsg` command-line tool.
- The first Local Messages tool surface includes preflight checks, chat listing, chat history reads, contact resolution, and bounded chat watching.
- Message search is deferred until the underlying local tool exposes an explicit search capability.
- A **Broad Read** requires explicit confirmation; a specific 1:1 chat read requested by the user does not.
- Targeted chat history reads default to 50 messages and max out at 200 messages in v1.
- The Local Messages Integration may expose raw message text to the **Execution Agent** for explicitly requested targeted reads.
- The Local Messages Integration supports 1:1 chats in v1; group-chat support is intentionally out of scope.
- Local Messages sends are text-only in v1; attachments are out of scope.
- Local Messages v1 does not expose reactions, mark-read, or typing indicators.
- Ambiguous name/contact/chat resolution returns **Recipient Candidates** and requires the user to choose; Boop must not guess.
- Local Messages audit logs and dashboard activity should store **Message Metadata**, not message bodies.
- Chat watching is a **One-Shot Watch**, not a persistent background watcher.
- Local Messages access is **User-Initiated Message Access** only in v1; automations and proactive flows cannot read the local inbox.
- The Local Messages Integration is host-Mac-only in v1 and assumes Boop runs on the Mac that owns the Messages database.
- Sending through the **Local Messages Integration** requires both a **Draft** and an **Approval Gate** enforced inside the local send tool immediately before execution.
- An **Approval Token** is created only by the **Interaction Agent** after explicit user confirmation; an **Execution Agent** cannot self-approve a send.
- The local send tool must verify the draft id, approval token, recipient, exact message text hash, attachment list/hash, and expiry before calling the local send command.
- Editing a **Draft** clears any prior **Approval Token** and requires fresh approval.
- Message contents read through the **Local Messages Integration** do not automatically become **Memory**.
- Boop summarizes local message contents by default and quotes exact messages only when the user asks or the task requires exact wording.
- A **Sendblue Thread** is distinct from the user’s local Messages.app inbox.

## Example dialogue

> **Dev:** “Can Boop check what Mary texted me yesterday?”
> **Domain expert:** “Yes, through the **Local Messages Integration**, but only an **Execution Agent** should get that access for the specific task.”
>
> **Dev:** “If Boop drafts a reply, can it send automatically when I say yes?”
> **Domain expert:** “No. The reply is first saved as a **Draft**, then the actual Messages.app send must pass an **Approval Gate** showing the exact recipient and text.”

## Flagged ambiguities

- “iMessage inbox” was ambiguous because macOS Messages can include both iMessage and SMS. Resolved: use **Local Messages Integration** for the local macOS capability.
- “Texting” was ambiguous between the **Sendblue Thread** and the user’s local Messages.app inbox. Resolved: **Sendblue Thread** means Boop’s external messaging interface; **Local Messages Integration** means the user’s personal local inbox.
- “Read” was ambiguous between a targeted chat lookup and a wider inbox scan. Resolved: use **Broad Read** for multi-chat, full-inbox, search, or watch operations that need stronger confirmation.
- “Watch” was ambiguous between a temporary task and a persistent inbox listener. Resolved: v1 uses **One-Shot Watch** only.
- “Approval” was ambiguous between a model instruction and an enforceable backend state. Resolved: an **Approval Gate** requires both explicit user confirmation and an **Approval Token** checked by the local send tool.
- “Access” was ambiguous between user-requested lookups and recurring/proactive monitoring. Resolved: v1 only supports **User-Initiated Message Access**.
- “Recipient” was ambiguous when a contact has multiple handles or chats. Resolved: use **Recipient Candidate** until the user chooses exactly one.
