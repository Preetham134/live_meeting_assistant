# TwinMind Live Suggestions Assignment

A browser-based live meeting copilot that listens to microphone audio, transcribes the conversation in chunks, and surfaces timely AI suggestions while the conversation is happening. Clicking any suggestion opens a concise, context-aware explanation in the chat panel.

This project was built for the TwinMind Live Suggestions assignment, where the main goal is to show the right suggestion at the right time during a live conversation.

---

## Demo Links

- **Deployed app:** `<add your deployed URL here>`
- **GitHub repository:** `<add your GitHub URL here>`

---

## Core Features

### 1. Live microphone transcription
- User starts recording from the browser.
- Audio is captured with the browser `MediaRecorder` API.
- Audio is processed in chunk-based cycles, defaulting to every **25 seconds**.
- Each chunk is sent to Groq Whisper for transcription.
- Transcript appends with timestamps and auto-scrolls to the latest line.

### 2. Live suggestions
- Suggestions refresh automatically, defaulting to every **30 seconds**.
- Manual **Refresh Suggestions** button is available for immediate updates.
- Each refresh returns exactly **3 fresh suggestions**.
- New suggestion batches appear at the top, while older batches stay visible.
- Each suggestion has a type badge, such as:
  - `question-to-ask`
  - `talking-point`
  - `answer`
  - `fact-check`
  - `clarification`
  - `risk`
  - `action`

### 3. Chat panel
- Clicking a suggestion adds it to the chat and generates a concise, actionable answer.
- Users can also type their own questions directly.
- Chat supports meeting-related, partially related, and general out-of-context questions.
- One continuous chat history is maintained per session.

### 4. Export
- The **Export Session** button downloads a JSON file containing:
  - settings
  - running meeting summary
  - full transcript with timestamps
  - every suggestion batch with timestamps and types
  - full chat history with timestamps

### 5. Editable settings
The app includes a top settings panel where evaluators can modify prompts and runtime parameters without changing code.

Editable settings include:
- live suggestion prompt
- chat / detailed-answer prompt
- suggestion context window
- clicked suggestion after-context chunks
- manual chat recent transcript window
- transcription chunk duration
- suggestion refresh interval
- temperature
- suggestion model
- chat model
- transcription model

Strong default values are hardcoded, but the UI can override them at runtime.

---

## Tech Stack

### Frontend
- **React + Vite**
- Plain CSS for layout and styling
- Browser `MediaRecorder` API for microphone capture

### AI / Model APIs
- **Groq Whisper Large V3** for transcription
- **Groq GPT-OSS 120B** for live suggestions and chat answers

### State Management
- React `useState` and `useRef`
- No database
- No login
- No persistent storage after page reload

---

## Why this stack?

I chose React because the assignment emphasizes a live product-like experience with three columns: transcript, suggestions, and chat. React made it easier to manage microphone state, timers, transcript updates, suggestion batches, chat history, and settings from a single client-side app.

I intentionally avoided a backend to keep the implementation lightweight and focused on the assignment goals: prompt quality, context strategy, responsiveness, and clean UI. The Groq API key is entered by the evaluator in the UI and is never hardcoded in the repo.

---

## Setup Instructions

### 1. Clone the repo

```bash
git clone <your-repo-url>
cd <your-repo-folder>
```

### 2. Install dependencies

```bash
npm install
```

### 3. Run locally

```bash
npm run dev
```

Open the local Vite URL in Chrome.

### 4. Enter Groq API key

Paste a Groq API key in the app and click **OK**. The app validates the key before recording starts.

### 5. Start recording

Click **Start Recording** and speak. Transcript chunks will appear automatically. Suggestions will refresh automatically based on the configured interval.

---

## Recommended Browser

Use **Google Chrome**. Microphone recording behavior may vary across browsers because the app uses the browser `MediaRecorder` API.

---

## Architecture Overview

```text
Browser Mic
   ↓
MediaRecorder chunk cycle
   ↓
Groq Whisper Large V3
   ↓
Transcript chunks with timestamps
   ↓
Rolling transcript window
   ↓
Groq GPT-OSS 120B
   ↓
3 live suggestions every refresh
   ↓
Suggestion click
   ↓
Context-aware chat answer
```

---

## How Live Transcription Works

The app uses a chunk-based recording loop instead of true WebSocket streaming.

Flow:
1. User clicks **Start Recording**.
2. Browser requests microphone access.
3. `MediaRecorder` records audio for the configured chunk duration, default **25 seconds**.
4. The current recorder stops and produces a clean audio blob.
5. The blob is sent to Groq Whisper.
6. The returned transcript is appended to the transcript panel.
7. A new recording cycle starts automatically while the user is still recording.

This gives a live meeting experience with an acceptable delay while avoiding fragile partial-audio streaming issues.

---

## How Suggestions Work

Suggestions are generated from a rolling transcript window.

Default context strategy:
- use the latest **5 transcript chunks** for suggestion generation
- prioritize the latest chunk while retaining recent conversation context
- pass recent previous suggestions so the model avoids repeating itself
- pass previous batch types so the model varies suggestion categories

The model is instructed to return JSON only:

```json
[
  { "type": "clarification", "text": "..." },
  { "type": "talking-point", "text": "..." },
  { "type": "answer", "text": "..." }
]
```

Each batch is stored with:
- batch id
- timestamp
- context snapshot used to generate the batch
- transcript start/end indexes
- 3 typed suggestions

---

## Suggestion Prompt Strategy

The live suggestion prompt is designed to optimize for:

1. **Timeliness**
   - Suggestions are based on recent transcript chunks.
   - New batches are generated automatically and manually.

2. **Variety**
   - The model can choose from question-to-ask, talking-point, answer, fact-check, clarification, risk, and action.
   - It is explicitly told not to always use the same type combination.

3. **Grounding**
   - Suggestions must be based only on transcript context.
   - The prompt discourages invented dates, owners, metrics, tools, or prior decisions.

4. **Low repetition**
   - Previous suggestion texts are passed back to the model.
   - If the model repeats the common trio of question/action/risk too much, the app retries once with a stronger variety instruction.

5. **Safety against hallucination**
   - The app checks for suspicious unsupported phrases like “last week,” “QA lead,” “confirmed,” and similar terms.
   - If found, it retries once with a stronger grounding instruction.

---

## How Chat Works

The chat supports two paths.

### 1. Clicking a suggestion

When a suggestion is clicked, the app does not simply use the latest transcript. Instead, each suggestion batch stores the transcript snapshot that was used to create it.

Clicked-suggestion context includes:
- the transcript snapshot used when the suggestion was generated
- up to 2 transcript chunks after that suggestion batch, if available
- the clicked suggestion text as the user query

This avoids a common issue: if a user clicks an old suggestion later in a long meeting, the latest transcript may no longer contain the relevant context.

### 2. Manual chat questions

For typed chat questions, the app uses:
- running meeting summary
- latest transcript chunks, default **5 chunks**
- user query

This lets the chat answer questions about earlier parts of the meeting without sending the full transcript every time.

---

## Chat Prompt Strategy

The chat prompt is optimized for concise meeting usefulness.

Rules include:
- keep answers brief and actionable
- use bullets where possible
- do not invent owners, dates, metrics, tools, or decisions
- if the transcript partially supports the question, say what is known and what is missing
- for open-ended decision or risk questions, reason from the meeting context and give recommendations
- for unrelated general questions, state that it is outside the meeting context and answer briefly using general knowledge

---

## Running Meeting Summary

A running summary is updated after each transcript chunk.

The summary preserves:
- important decisions
- blockers
- risks
- open questions
- action items

It is kept concise, max around 8 bullets, and is mainly used to support manual chat questions about earlier meeting context.

---

## Settings Defaults

Default settings:

```text
Suggestion context window: 5 transcript chunks
Clicked suggestion after-context: 2 transcript chunks
Manual chat recent window: 5 transcript chunks
Transcription chunk duration: 25 seconds
Suggestion refresh interval: 30 seconds
Temperature: 0.7
Suggestion model: openai/gpt-oss-120b
Chat model: openai/gpt-oss-120b
Transcription model: whisper-large-v3
```

These defaults were selected to balance latency, context quality, and suggestion freshness.

---

## Tradeoffs

### 1. Chunk-based transcription instead of true streaming

True audio streaming would require more infrastructure and more edge-case handling. For this assignment, I implemented chunk-based live transcription using `MediaRecorder`. It provides a live experience with acceptable delay and simpler, more reliable browser behavior.

### 2. Client-only architecture

The app calls Groq directly from the browser using the evaluator-provided API key. This keeps setup simple and avoids managing a backend. In production, I would move API calls to a backend to avoid exposing keys in browser requests and to add rate limiting, logging, and stronger error handling.

### 3. Rolling context window instead of full transcript for suggestions

Using the full transcript every 30 seconds would increase latency and noise. The rolling window keeps suggestions focused on the current discussion. A running summary is used separately for manual chat questions that may refer to earlier meeting context.

### 4. Snapshot-based clicked suggestion context

Older suggestions need their original context. I store the transcript snapshot used to generate each suggestion batch, then include after-context when clicked. This is more accurate than using only the latest transcript.

### 5. Prompt-based decision making

The system does not hard-code which suggestion type should appear. It lets the model choose the right mix based on the conversation while using prompt constraints and retry guardrails to improve diversity and grounding.

---

## Error Handling

Implemented error handling includes:
- Groq API key validation before recording
- visible invalid-key state
- transcription failure message
- suggestion failure message without deleting previous suggestions
- microphone permission errors
- fallback parsing if the model does not return perfect JSON
- safe fallback values for invalid settings

---

## Export Format

Exported JSON includes:

```json
{
  "exportedAt": "ISO timestamp",
  "settings": {},
  "meetingSummary": "...",
  "transcript": [],
  "suggestionBatches": [],
  "chatHistory": []
}
```

This is intended to make evaluation easy: the evaluator can inspect what was said, what suggestions were shown, what was clicked, and how the chat answered.

---

## Known Limitations

- Transcription is chunk-based, so text can sometimes start or end mid-sentence.
- The app is client-only; production usage should route API calls through a backend.
- Suggestion quality depends on transcript quality and prompt behavior.
- The running meeting summary is generated by an LLM, so it is useful but not a guaranteed source of truth.
- No data is persisted after page reload.

---

## Future Improvements

If I had more time, I would add:
- true low-latency streaming transcription
- backend proxy for Groq calls
- token usage and latency metrics
- more robust JSON schema validation
- optional speaker diarization
- richer meeting summary and action-item extraction
- automated tests for prompt parsing and export format

---

## Evaluation Focus

This implementation focuses on the assignment’s main evaluation areas:

1. **Live suggestion quality**  
   Suggestions are timely, varied, concise, and grounded in recent context.

2. **Detailed chat answers**  
   Clicked suggestions produce concise, actionable explanations using the correct local context.

3. **Prompt engineering**  
   The app uses editable prompts, context windows, previous suggestion avoidance, grounding rules, and retry guardrails.

4. **Full-stack engineering**  
   The app has live microphone capture, chunk transcription, API integration, state management, error handling, export, and settings.

5. **Tradeoff awareness**  
   The implementation prioritizes reliability and usefulness over over-engineered infrastructure.

---

## Demo Script

1. Paste a Groq API key and click **OK**.
2. Click **Start Recording**.
3. Discuss a realistic meeting scenario with blockers, deadlines, and open questions.
4. Watch transcript chunks appear.
5. Watch live suggestions refresh automatically.
6. Click a suggestion to open a detailed answer in chat.
7. Ask a manual follow-up question.
8. Click **Export Session** to download the full JSON record.

---

## Notes

The key design principle is: **latest context drives suggestions, stored local context grounds clicked answers, and running summary supports manual chat.**

