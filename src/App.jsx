import { useEffect, useRef, useState } from 'react'

const FALLBACK_SUGGESTION_TEXT = 'No additional suggestion available.'
const ALLOWED_SUGGESTION_TYPES = [
  'question-to-ask',
  'talking-point',
  'answer',
  'fact-check',
  'clarification',
  'risk',
  'action',
]
const COMMON_SUGGESTION_TRIO = ['action', 'question-to-ask', 'risk']
const SUSPICIOUS_UNSUPPORTED_PHRASES = [
  'last week',
  'eod tuesday',
  'wednesday morning',
  'thursday morning',
  'qa lead',
  'product manager',
  'sla',
  'merged',
  'already implemented',
  'confirmed',
]
const DEFAULT_SETTINGS = {
  liveSuggestionPrompt: `Generate exactly 3 fresh live meeting suggestions from the recent transcript.

Allowed suggestion types:
- question-to-ask: a useful question someone should ask next
- talking-point: a useful point someone can bring up
- answer: a concise answer to a question that was just asked in the conversation
- fact-check: a statement that should be verified or corrected
- clarification: something ambiguous that should be clarified
- risk: a risk or blocker the team should notice
- action: a concrete next step

Rules:
- Return JSON only
- Return exactly 3 items
- Each item must have "type" and "text"
- Choose the best mix of types based on the latest transcript
- Do NOT always use question-to-ask, action, and risk
- Prefer at least one of these when appropriate: talking-point, answer, fact-check, clarification
- Avoid repeating the same type combination across consecutive batches
- Avoid repeating the same idea from previous suggestion batches
- Prioritize the latest transcript, but use recent prior context when helpful
- Keep each suggestion concise and useful immediately in the meeting
- Suggestions must be based only on the transcript context
- Do not invent specific owners, dates, deadlines, metrics, tools, or prior events
- If the transcript does not provide enough detail, make it a clarification question
- Fact-check suggestions should verify statements already made in the transcript
- Use "confirm", "clarify", "ask whether", or "check if" when information is uncertain
- Avoid making unsupported assumptions

Recent transcript:
{recentContext}

Previous suggestion types and texts to avoid repeating:
{previousSuggestionTexts}

Previous batch types:
{previousBatchTypes}

{extraInstruction}

Output format:
[
  {"type": "clarification", "text": "..."},
  {"type": "talking-point", "text": "..."},
  {"type": "answer", "text": "..."}
]`,
  chatPrompt: `Based on the meeting transcript and user query, provide a concise, useful response.

Rules:
- Keep the answer under 180 words unless the user explicitly asks for more detail.
- Prefer 3-6 bullets.
- Do not invent specific owners, dates, exact metrics, tools, or prior decisions unless they appear in the transcript.
- If the user asks for specific missing facts, use:
  "What we know from the meeting:"
  and
  "What is missing / needs clarification:"
- If the user asks an open-ended risk, tradeoff, recommendation, or decision question, answer naturally with:
  - Key risks or tradeoffs
  - Recommended next steps
  - Any assumptions clearly stated
- If the query is unrelated to the meeting, start with:
  "This is outside the current meeting context, but briefly:"
  then answer from general knowledge.
- If the transcript partially supports the answer, use the transcript plus reasonable general knowledge, but make assumptions clear.
- If the context contains "before", "used to generate", and "after" sections, use them to explain the clicked suggestion in the correct local meeting moment.
- Do not rely on unrelated latest transcript unless it is included in the provided context.
- Stay grounded in the provided context.
- Do not invent owners, dates, exact metrics, tools, or prior decisions.
- If a running meeting summary is provided, use it to answer questions about earlier parts of the meeting.
- Use recent transcript for the latest details.
- If summary and recent transcript conflict, mention uncertainty instead of inventing.
- For clicked suggestions, use the provided suggestion context as the primary source.

Meeting context:
{contextForChat}

User query:
{query}`,
  suggestionContextWindow: 5,
  clickedSuggestionAfterChunks: 2,
  manualChatRecentWindow: 5,
  transcriptionChunkSeconds: 25,
  suggestionRefreshSeconds: 30,
  temperature: 0.7,
  suggestionModel: 'openai/gpt-oss-120b',
  chatModel: 'openai/gpt-oss-120b',
  transcriptionModel: 'whisper-large-v3',
}

function App() {
  const [transcript, setTranscript] = useState([])
  const [suggestionBatches, setSuggestionBatches] = useState([])
  const [chatHistory, setChatHistory] = useState([])
  const [inputValue, setInputValue] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [isApiKeyValid, setIsApiKeyValid] = useState(false)
  const [apiKeyStatus, setApiKeyStatus] = useState('idle')
  const [meetingSummary, setMeetingSummary] = useState('')
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [lastTranscribedAt, setLastTranscribedAt] = useState(null)
  const [isGeneratingSuggestions, setIsGeneratingSuggestions] = useState(false)
  const [lastSuggestionAt, setLastSuggestionAt] = useState(null)
  const [recordingStatus, setRecordingStatus] = useState('Stopped')
  const [recordingError, setRecordingError] = useState('')
  const [suggestionError, setSuggestionError] = useState('')
  const mediaStreamRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const currentChunksRef = useRef([])
  const recordingCycleTimerRef = useRef(null)
  const suggestionTimerRef = useRef(null)
  const isRecordingRef = useRef(false)
  const pendingSuggestionRefreshRef = useRef(false)
  const nextSuggestionBatchIdRef = useRef(1)
  const meetingSummaryRef = useRef('')
  const transcriptRef = useRef([])
  const suggestionBatchesRef = useRef([])
  const transcriptEndRef = useRef(null)
  const chatEndRef = useRef(null)

  useEffect(() => {
    transcriptRef.current = transcript
  }, [transcript])

  useEffect(() => {
    suggestionBatchesRef.current = suggestionBatches
  }, [suggestionBatches])

  useEffect(() => {
    meetingSummaryRef.current = meetingSummary
  }, [meetingSummary])

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatHistory])

  useEffect(() => {
    return () => {
      clearRecordingCycleTimer()
      clearSuggestionTimer()

      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop()
      }

      stopMediaStream()
    }
  }, [])

  const createTimestamp = () => new Date().toISOString()

  const getNumericSetting = (key) => {
    const value = Number(settings[key])
    const fallback = Number(DEFAULT_SETTINGS[key])

    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  const getPromptSetting = (key) =>
    settings[key] && String(settings[key]).trim()
      ? settings[key]
      : DEFAULT_SETTINGS[key]

  const getTextSetting = (key) =>
    settings[key] && String(settings[key]).trim()
      ? settings[key]
      : DEFAULT_SETTINGS[key]

  const updateSetting = (key, value) => {
    setSettings((previousSettings) => ({
      ...previousSettings,
      [key]: value,
    }))
  }

  const formatTimestamp = (timestamp) => {
    if (!timestamp) {
      return ''
    }

    return new Date(timestamp).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  const normalizeTranscriptEntry = (entry) => {
    if (typeof entry === 'string') {
      return { timestamp: null, text: entry }
    }

    return {
      timestamp: entry?.timestamp ?? null,
      text: entry?.text ?? '',
    }
  }

  const normalizeSuggestionBatch = (batch, index) => {
    if (batch && Array.isArray(batch.items)) {
      return {
        id: batch.id ?? suggestionBatches.length - index,
        timestamp: batch.timestamp ?? null,
        contextSnapshot: batch.contextSnapshot ?? '',
        contextStartIndex:
          typeof batch.contextStartIndex === 'number' ? batch.contextStartIndex : null,
        contextEndIndex:
          typeof batch.contextEndIndex === 'number' ? batch.contextEndIndex : null,
        items: batch.items.map((item) => ({
          type: normalizeSuggestionType(item?.type),
          text: item?.text ?? '',
        })),
      }
    }

    if (Array.isArray(batch)) {
      return {
        id: suggestionBatches.length - index,
        timestamp: null,
        contextSnapshot: '',
        contextStartIndex: null,
        contextEndIndex: null,
        items: batch.map((item) => ({
          type: 'suggestion',
          text: typeof item === 'string' ? item : item?.text ?? '',
        })),
      }
    }

    return {
      id: suggestionBatches.length - index,
      timestamp: null,
      contextSnapshot: '',
      contextStartIndex: null,
      contextEndIndex: null,
      items: [],
    }
  }

  const normalizeChatMessage = (message) => ({
    role: message?.role ?? 'assistant',
    content: message?.content ?? '',
    timestamp: message?.timestamp ?? null,
  })

  const normalizeSuggestionType = (type) => {
    if (ALLOWED_SUGGESTION_TYPES.includes(type)) {
      return type
    }

    return 'suggestion'
  }

  const formatSuggestionType = (type) => type.replace(/-/g, ' ').toUpperCase()

  const isCommonSuggestionTrio = (items) => {
    const types = items
      .map((item) => normalizeSuggestionType(item?.type))
      .sort()

    return JSON.stringify(types) === JSON.stringify([...COMMON_SUGGESTION_TRIO].sort())
  }

  const hasSuspiciousUnsupportedPhrases = (items) =>
    items.some((item) =>
      SUSPICIOUS_UNSUPPORTED_PHRASES.some((phrase) =>
        item?.text?.toLowerCase().includes(phrase),
      ),
    )

  const clearRecordingCycleTimer = () => {
    if (recordingCycleTimerRef.current) {
      clearTimeout(recordingCycleTimerRef.current)
      recordingCycleTimerRef.current = null
    }
  }

  const clearSuggestionTimer = () => {
    if (suggestionTimerRef.current) {
      clearInterval(suggestionTimerRef.current)
      suggestionTimerRef.current = null
    }
  }

  const stopMediaStream = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }
  }

  const parseSuggestionItems = (content) => {
    const tryParseArray = (text) => {
      const parsed = JSON.parse(text)

      if (!Array.isArray(parsed)) {
        return null
      }

      return parsed
        .map((item) => ({
          type: normalizeSuggestionType(item?.type),
          text: item?.text?.trim?.() ?? '',
        }))
        .filter((item) => item.text)
        .slice(0, 3)
    }

    try {
      const parsedItems = tryParseArray(content)

      if (parsedItems) {
        return parsedItems
      }
    } catch (error) {
      console.log(error)
    }

    const jsonArrayMatch = content.match(/\[[\s\S]*\]/)

    if (jsonArrayMatch) {
      try {
        const parsedItems = tryParseArray(jsonArrayMatch[0])

        if (parsedItems) {
          return parsedItems
        }
      } catch (error) {
        console.log(error)
      }
    }

    return content
      .split(/\n(?=\s*(?:\d+[\).\s-]|-))/)
      .map((item) => item.replace(/^\s*(?:\d+[\).\s-]*|-)\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 3)
      .map((text) => ({ type: 'suggestion', text }))
  }

  const getTranscriptContext = (count) =>
    transcriptRef.current
      .map(normalizeTranscriptEntry)
      .slice(-count)
      .map((entry) => entry.text)
      .join('\n')

  const buildLocalContextForSuggestionBatch = (batch) => {
    const normalizedBatch = normalizeSuggestionBatch(batch, 0)
    const allTranscript = transcriptRef.current.map(normalizeTranscriptEntry)
    const afterChunkCount = getNumericSetting('clickedSuggestionAfterChunks')
    const snapshot = normalizedBatch.contextSnapshot || ''
    const afterChunks = []

    if (typeof normalizedBatch.contextEndIndex === 'number') {
      for (let offset = 1; offset <= afterChunkCount; offset += 1) {
        const nextChunk = allTranscript[normalizedBatch.contextEndIndex + offset]?.text || ''

        if (nextChunk) {
          afterChunks.push(nextChunk)
        }
      }
    }

    return `Context used to generate this suggestion:
${snapshot || 'Not available'}

Context after this suggestion:
${afterChunks.join('\n') || 'Not available'}`.trim()
  }

  const getPreviousSuggestionTexts = () =>
    suggestionBatchesRef.current
      .flatMap((batch, index) => normalizeSuggestionBatch(batch, index).items)
      .map((item) => `${item.type}: ${item.text}`)
      .slice(0, 12)
      .join('\n')

  const requestSuggestionItems = async (recentContext, extraInstruction = '') => {
    const previousBatch = suggestionBatchesRef.current[0]
    const previousBatchTypes = previousBatch
      ? normalizeSuggestionBatch(previousBatch, 0).items.map((item) => item.type).join(', ')
      : 'none'
    const suggestionPrompt = getPromptSetting('liveSuggestionPrompt')
      .replace('{recentContext}', recentContext)
      .replace('{previousSuggestionTexts}', getPreviousSuggestionTexts())
      .replace('{previousBatchTypes}', previousBatchTypes)
      .replace('{extraInstruction}', extraInstruction)

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: getTextSetting('suggestionModel'),
          messages: [
            {
              role: 'system',
              content:
                'You are a live meeting copilot. Generate timely, varied, high-value suggestions during a conversation. Choose the most useful suggestion types based on what was just said. Stay strictly grounded in the transcript. Do not invent facts, dates, owners, tools, prior decisions, or previous events.',
            },
            {
              role: 'user',
              content: suggestionPrompt,
            },
          ],
          temperature: getNumericSetting('temperature'),
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        console.log(data?.error?.message || data)
        return null
      }

      const content = data?.choices?.[0]?.message?.content

      if (!content) {
        return null
      }

      return parseSuggestionItems(content)
    } catch (error) {
      console.log(error)
      return null
    }
  }

  const generateSuggestionsFromCurrentContext = async () => {
    const allTranscript = transcriptRef.current.map(normalizeTranscriptEntry)
    const suggestionWindow = getNumericSetting('suggestionContextWindow')
    const contextStartIndex = Math.max(0, allTranscript.length - suggestionWindow)
    const contextEndIndex = allTranscript.length - 1
    const recentContext = allTranscript
      .slice(contextStartIndex, contextEndIndex + 1)
      .map((entry) => entry.text)
      .join('\n')

    if (!recentContext.trim()) {
      return
    }

    setIsGeneratingSuggestions(true)
    setSuggestionError('')

    try {
      let parsedItems = await requestSuggestionItems(recentContext)

      if (!parsedItems) {
        setSuggestionError('Suggestion refresh failed. Previous suggestions are still available.')
        return
      }

      const previousBatch = suggestionBatchesRef.current[0]
      const previousItems = previousBatch ? normalizeSuggestionBatch(previousBatch, 0).items : []
      const shouldRetryForVariety =
        isCommonSuggestionTrio(parsedItems) && previousItems.length > 0 && isCommonSuggestionTrio(previousItems)

      if (shouldRetryForVariety) {
        const retriedItems = await requestSuggestionItems(
          recentContext,
          'Regenerate using at least one of talking-point, answer, fact-check, or clarification.',
        )

        if (retriedItems && retriedItems.length > 0) {
          parsedItems = retriedItems
        }
      }

      if (hasSuspiciousUnsupportedPhrases(parsedItems)) {
        const retriedGroundedItems = await requestSuggestionItems(
          recentContext,
          'Regenerate the suggestions. Remove unsupported specifics such as invented dates, owners, prior events, or tools. Stay grounded only in the transcript.',
        )

        if (retriedGroundedItems && retriedGroundedItems.length > 0) {
          parsedItems = retriedGroundedItems
        }
      }

      const items = [...parsedItems]

      while (items.length < 3) {
        items.push({ type: 'suggestion', text: FALLBACK_SUGGESTION_TEXT })
      }

      const nextId =
        suggestionBatchesRef.current.length === 0
          ? nextSuggestionBatchIdRef.current
          : Math.max(
              nextSuggestionBatchIdRef.current,
              ...suggestionBatchesRef.current.map((batch, index) => normalizeSuggestionBatch(batch, index).id + 1),
            )

      const batch = {
        id: nextId,
        timestamp: createTimestamp(),
        contextSnapshot: recentContext,
        contextStartIndex,
        contextEndIndex,
        items: items.slice(0, 3),
      }

      nextSuggestionBatchIdRef.current = nextId + 1
      setSuggestionBatches((previousBatches) => [batch, ...previousBatches])
      setLastSuggestionAt(batch.timestamp)
    } finally {
      setIsGeneratingSuggestions(false)
    }
  }

  const updateMeetingSummary = async (newTranscriptText) => {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: getTextSetting('chatModel'),
          messages: [
            {
              role: 'system',
              content:
                'You maintain a concise running summary of a live meeting. Preserve important decisions, blockers, risks, open questions, and action items. Do not invent details.',
            },
            {
              role: 'user',
              content: `Update the running meeting summary using the new transcript chunk.

Existing summary:
${meetingSummaryRef.current || 'No summary yet.'}

New transcript chunk:
${newTranscriptText}

Rules:
- Keep the summary concise, max 8 bullets.
- Preserve important earlier context.
- Add new decisions, blockers, risks, open questions, and action items.
- Do not invent owners, dates, metrics, tools, or decisions.
- If something is uncertain, phrase it as uncertain.

Return only the updated summary.`,
            },
          ],
          temperature: getNumericSetting('temperature'),
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        console.log(data?.error?.message || data)
        return
      }

      const updatedSummary = data?.choices?.[0]?.message?.content?.trim?.()

      if (!updatedSummary) {
        return
      }

      meetingSummaryRef.current = updatedSummary
      setMeetingSummary(updatedSummary)
    } catch (error) {
      console.log(error)
    }
  }

  const transcribeAudioBlob = async (audioBlob) => {
    if (audioBlob.size < 10000) {
      return
    }

    setIsTranscribing(true)
    setRecordingError('')

    const formData = new FormData()
    formData.append('file', audioBlob, 'audio.webm')
    formData.append('model', getTextSetting('transcriptionModel'))

    try {
      const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      })

      const data = await response.json()

      if (!response.ok) {
        console.log(data?.error?.message || data)
        setRecordingError('Transcription failed. Please check your API key or try again.')
        return
      }

      const nextText = data?.text?.trim?.()

      if (!nextText) {
        return
      }

      const transcriptEntry = {
        timestamp: createTimestamp(),
        text: nextText,
      }
      const updatedTranscript = [...transcriptRef.current, transcriptEntry]

      transcriptRef.current = updatedTranscript
      setTranscript(updatedTranscript)
      setLastTranscribedAt(transcriptEntry.timestamp)
      void updateMeetingSummary(nextText)
    } catch (error) {
      console.log(error)
      setRecordingError('Transcription failed. Please check your API key or try again.')
    } finally {
      setIsTranscribing(false)
    }
  }

  const startRecordingCycle = () => {
    if (!mediaStreamRef.current || !isRecordingRef.current) {
      return
    }

    clearRecordingCycleTimer()
    currentChunksRef.current = []

    const recorder = new MediaRecorder(mediaStreamRef.current)
    mediaRecorderRef.current = recorder

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        currentChunksRef.current.push(event.data)
      }
    }

    recorder.onstop = async () => {
      const audioBlob = new Blob(currentChunksRef.current, { type: 'audio/webm' })

      currentChunksRef.current = []
      await transcribeAudioBlob(audioBlob)

      if (pendingSuggestionRefreshRef.current) {
        pendingSuggestionRefreshRef.current = false
        await generateSuggestionsFromCurrentContext()
      }

      if (isRecordingRef.current) {
        startRecordingCycle()
        return
      }

      mediaRecorderRef.current = null
      stopMediaStream()
      setIsRecording(false)
      setRecordingStatus('Stopped')
    }

    recorder.start()
    const chunkMs = getNumericSetting('transcriptionChunkSeconds') * 1000
    recordingCycleTimerRef.current = setTimeout(() => {
      if (recorder.state === 'recording') {
        recorder.stop()
      }
    }, chunkMs)
  }

  const flushCurrentCycle = async ({ generateSuggestionsAfter = false } = {}) => {
    const recorder = mediaRecorderRef.current

    if (!recorder || recorder.state !== 'recording') {
      if (generateSuggestionsAfter) {
        await generateSuggestionsFromCurrentContext()
      }
      return
    }

    pendingSuggestionRefreshRef.current = generateSuggestionsAfter
    clearRecordingCycleTimer()
    recorder.stop()
  }

  const validateApiKey = async () => {
    if (!apiKey.trim()) {
      alert('Please enter a Groq API key')
      return
    }

    setApiKeyStatus('checking')

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: getTextSetting('chatModel'),
          messages: [{ role: 'user', content: 'Hello' }],
          temperature: getNumericSetting('temperature'),
        }),
      })

      if (response.ok) {
        setIsApiKeyValid(true)
        setApiKeyStatus('accepted')
        setRecordingError('')
        return
      }

      setIsApiKeyValid(false)
      setApiKeyStatus('invalid')
    } catch (error) {
      console.log(error)
      setIsApiKeyValid(false)
      setApiKeyStatus('invalid')
    }
  }

  const generateChatResponse = async (query, providedContext = '') => {
    let contextForChat

    if (providedContext && providedContext.trim()) {
      contextForChat = providedContext
    } else {
      const latestContext = getTranscriptContext(getNumericSetting('manualChatRecentWindow'))

      contextForChat = `Running meeting summary:
${meetingSummaryRef.current || 'No summary available yet.'}

Recent transcript:
${latestContext || 'No recent transcript available.'}`
    }

    const chatUserPrompt = getPromptSetting('chatPrompt')
      .replace('{contextForChat}', contextForChat)
      .replace('{query}', query)

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: getTextSetting('chatModel'),
          messages: [
            {
              role: 'system',
              content:
                'You are a concise AI meeting copilot. Use the meeting transcript when the question is related to the meeting, but choose the response format naturally. For specific factual questions, state what is known and what is missing. For open-ended advice or risk questions, reason from the transcript and give practical recommendations. For unrelated general questions, briefly say it is outside the meeting context and answer using general knowledge. Do not invent specific owners, dates, metrics, tools, or prior decisions not present in the transcript.',
            },
            {
              role: 'user',
              content: chatUserPrompt,
            },
          ],
          temperature: getNumericSetting('temperature'),
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        console.log(data?.error?.message || data)
        setChatHistory((previousHistory) => [
          ...previousHistory,
          {
            role: 'assistant',
            content: 'Error generating response',
            timestamp: createTimestamp(),
          },
        ])
        return
      }

      const assistantMessage = data?.choices?.[0]?.message?.content

      setChatHistory((previousHistory) => [
        ...previousHistory,
        {
          role: 'assistant',
          content: assistantMessage || 'Error generating response',
          timestamp: createTimestamp(),
        },
      ])
    } catch (error) {
      console.log(error)
      setChatHistory((previousHistory) => [
        ...previousHistory,
        {
          role: 'assistant',
          content: 'Error generating response',
          timestamp: createTimestamp(),
        },
      ])
    }
  }

  const startRecording = async () => {
    if (isRecordingRef.current) {
      return
    }

    if (!isApiKeyValid) {
      setRecordingError('Please validate a working Groq API key before recording.')
      alert('Please enter a valid Groq API key')
      return
    }

    try {
      clearRecordingCycleTimer()
      clearSuggestionTimer()
      pendingSuggestionRefreshRef.current = false
      setRecordingError('')
      setSuggestionError('')
      setRecordingStatus('Recording...')

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

      mediaStreamRef.current = stream
      isRecordingRef.current = true
      setIsRecording(true)

      startRecordingCycle()
      const suggestionIntervalMs = getNumericSetting('suggestionRefreshSeconds') * 1000
      suggestionTimerRef.current = setInterval(() => {
        void generateSuggestionsFromCurrentContext()
      }, suggestionIntervalMs)
    } catch (error) {
      const message =
        error.name === 'NotAllowedError'
          ? 'Microphone permission denied'
          : 'Unable to access microphone'

      console.log(error)
      setRecordingError(message)
      setRecordingStatus('Stopped')
      isRecordingRef.current = false
      setIsRecording(false)
      stopMediaStream()
    }
  }

  const stopRecording = () => {
    isRecordingRef.current = false
    setIsRecording(false)
    setRecordingStatus('Stopping...')
    clearRecordingCycleTimer()
    clearSuggestionTimer()

    const recorder = mediaRecorderRef.current

    if (recorder && recorder.state === 'recording') {
      recorder.stop()
      return
    }

    stopMediaStream()
    setRecordingStatus('Stopped')
  }

  const handleRefreshSuggestions = async () => {
    if (isRecordingRef.current) {
      await flushCurrentCycle({ generateSuggestionsAfter: true })
      return
    }

    await generateSuggestionsFromCurrentContext()
  }

  const handleSuggestionClick = (suggestion, batch) => {
    const localContext = buildLocalContextForSuggestionBatch(batch)

    setChatHistory((previousHistory) => [
      ...previousHistory,
      {
        role: 'user',
        content: suggestion.text,
        timestamp: createTimestamp(),
      },
    ])
    void generateChatResponse(suggestion.text, localContext)
  }

  const handleSubmit = (event) => {
    event.preventDefault()

    const trimmedValue = inputValue.trim()

    if (!trimmedValue) {
      return
    }

    setChatHistory((previousHistory) => [
      ...previousHistory,
      {
        role: 'user',
        content: trimmedValue,
        timestamp: createTimestamp(),
      },
    ])
    setInputValue('')
    void generateChatResponse(trimmedValue)
  }

  const exportSession = () => {
    const exportData = {
      exportedAt: createTimestamp(),
      settings,
      meetingSummary,
      transcript: transcript.map(normalizeTranscriptEntry),
      suggestionBatches: suggestionBatches.map((batch, index) => normalizeSuggestionBatch(batch, index)),
      chatHistory: chatHistory.map(normalizeChatMessage),
    }

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')

    link.href = url
    link.download = 'twinmind-session-export.json'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="app-shell">
      <div className="settings-panel">
        <div className="settings-group">
          <div className="settings-field">
            <label className="settings-label">Suggestion Window</label>
            <input
              className="settings-input"
              type="number"
              value={settings.suggestionContextWindow}
              onChange={(event) => updateSetting('suggestionContextWindow', event.target.value)}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Clicked After Chunks</label>
            <input
              className="settings-input"
              type="number"
              value={settings.clickedSuggestionAfterChunks}
              onChange={(event) => updateSetting('clickedSuggestionAfterChunks', event.target.value)}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Manual Chat Window</label>
            <input
              className="settings-input"
              type="number"
              value={settings.manualChatRecentWindow}
              onChange={(event) => updateSetting('manualChatRecentWindow', event.target.value)}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Chunk Seconds</label>
            <input
              className="settings-input"
              type="number"
              value={settings.transcriptionChunkSeconds}
              onChange={(event) => updateSetting('transcriptionChunkSeconds', event.target.value)}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Refresh Seconds</label>
            <input
              className="settings-input"
              type="number"
              value={settings.suggestionRefreshSeconds}
              onChange={(event) => updateSetting('suggestionRefreshSeconds', event.target.value)}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Temperature</label>
            <input
              className="settings-input"
              type="number"
              step="0.1"
              value={settings.temperature}
              onChange={(event) => updateSetting('temperature', event.target.value)}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Suggestion Model</label>
            <input
              className="settings-input"
              type="text"
              value={settings.suggestionModel}
              onChange={(event) => updateSetting('suggestionModel', event.target.value)}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Chat Model</label>
            <input
              className="settings-input"
              type="text"
              value={settings.chatModel}
              onChange={(event) => updateSetting('chatModel', event.target.value)}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Transcription Model</label>
            <input
              className="settings-input"
              type="text"
              value={settings.transcriptionModel}
              onChange={(event) => updateSetting('transcriptionModel', event.target.value)}
            />
          </div>
          <div className="settings-field settings-field-button">
            <button
              type="button"
              className="settings-button"
              onClick={() => setSettings(DEFAULT_SETTINGS)}
            >
              Reset Settings
            </button>
          </div>
        </div>
        <div className="settings-group settings-group-prompts">
          <div className="settings-field settings-field-wide">
            <label className="settings-label">Live Suggestion Prompt</label>
            <textarea
              className="settings-textarea"
              value={settings.liveSuggestionPrompt}
              onChange={(event) => updateSetting('liveSuggestionPrompt', event.target.value)}
            />
          </div>
          <div className="settings-field settings-field-wide">
            <label className="settings-label">Chat Prompt</label>
            <textarea
              className="settings-textarea"
              value={settings.chatPrompt}
              onChange={(event) => updateSetting('chatPrompt', event.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="app">
        <section className="column">
          <div className="column-header column-header-spread">
            <h2>Transcript</h2>
            <button type="button" className="secondary-button" onClick={exportSession}>
              Export Session
            </button>
          </div>
          <div className="api-key-row">
            <input
              type="password"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value)
                setIsApiKeyValid(false)
                setApiKeyStatus('idle')
              }}
              placeholder="Enter Groq API key"
              className="api-key-input"
            />
            <button
              type="button"
              className="secondary-button api-key-button"
              onClick={validateApiKey}
              disabled={apiKeyStatus === 'checking'}
            >
              OK
            </button>
          </div>
          {apiKeyStatus === 'checking' ? <p className="status-text">Checking...</p> : null}
          {apiKeyStatus === 'accepted' ? <p className="accepted-text">Accepted</p> : null}
          {apiKeyStatus === 'invalid' ? <p className="error-text">Invalid API Key</p> : null}
          <div className="recording-controls">
            <button
              type="button"
              className="secondary-button"
              onClick={startRecording}
              disabled={isRecording}
            >
              Start Recording
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={stopRecording}
              disabled={!isRecording}
            >
              Stop Recording
            </button>
          </div>
          <p className="status-text">{recordingStatus}</p>
          {isRecording ? (
            <p className="meta-text">
              Transcript updates every ~{getNumericSetting('transcriptionChunkSeconds')} seconds.
            </p>
          ) : null}
          {isRecording ? (
            <p className="meta-text">
              Suggestions auto-refresh every ~{getNumericSetting('suggestionRefreshSeconds')} seconds.
            </p>
          ) : null}
          {isTranscribing ? <p className="meta-text">Transcribing...</p> : null}
          <p className="meta-text">Meeting summary maintained for chat context.</p>
          {lastTranscribedAt ? (
            <p className="meta-text">Last transcript update: {formatTimestamp(lastTranscribedAt)}</p>
          ) : null}
          {recordingError ? <p className="error-text">{recordingError}</p> : null}
          <div className="column-content">
            {transcript.length === 0 ? (
              <p className="empty-state">No transcript yet</p>
            ) : (
              transcript.map((entry, index) => {
                const normalizedEntry = normalizeTranscriptEntry(entry)

                return (
                  <p key={`${normalizedEntry.timestamp ?? 'transcript'}-${index}`} className="transcript-line">
                    {normalizedEntry.timestamp ? (
                      <span className="message-timestamp transcript-timestamp">
                        {formatTimestamp(normalizedEntry.timestamp)}
                      </span>
                    ) : null}{' '}
                    {normalizedEntry.text}
                  </p>
                )
              })
            )}
            <div ref={transcriptEndRef} />
          </div>
        </section>

        <section className="column">
          <div className="column-header column-header-spread">
            <h2>Live Suggestions</h2>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void handleRefreshSuggestions()}
              disabled={isGeneratingSuggestions}
            >
              Refresh Suggestions
            </button>
          </div>
          {isGeneratingSuggestions ? <p className="status-text">Refreshing suggestions...</p> : null}
          {lastSuggestionAt ? (
            <p className="meta-text">Last suggestion refresh: {formatTimestamp(lastSuggestionAt)}</p>
          ) : null}
          {isRecording ? (
            <p className="meta-text">
              Auto-refresh every ~{getNumericSetting('suggestionRefreshSeconds')}s while recording.
            </p>
          ) : null}
          {suggestionError ? <p className="error-text">{suggestionError}</p> : null}
          <div className="column-content">
            {suggestionBatches.length === 0 ? (
              <p className="empty-state">No suggestions yet</p>
            ) : (
              suggestionBatches.map((batch, batchIndex) => {
                const normalizedBatch = normalizeSuggestionBatch(batch, batchIndex)

                return (
                  <div key={`batch-${normalizedBatch.id}-${batchIndex}`} className="suggestion-batch">
                    <div className="suggestion-batch-header">
                      Batch {normalizedBatch.id}
                      {normalizedBatch.timestamp
                        ? ` | ${formatTimestamp(normalizedBatch.timestamp)}`
                        : ''}
                    </div>
                    {normalizedBatch.items.map((suggestion, suggestionIndex) => (
                      <button
                        key={`${suggestion.type}-${suggestionIndex}`}
                        type="button"
                        className="suggestion-card"
                        onClick={() => handleSuggestionClick(suggestion, normalizedBatch)}
                      >
                        <span className={`suggestion-type suggestion-type-${normalizeSuggestionType(suggestion.type)}`}>
                          {formatSuggestionType(suggestion.type)}
                        </span>
                        <span className="suggestion-text">{suggestion.text}</span>
                      </button>
                    ))}
                  </div>
                )
              })
            )}
          </div>
        </section>

        <section className="column chat-column">
          <div className="column-header">
            <h2>Chat</h2>
          </div>
          <div className="column-content">
            {chatHistory.length === 0 ? (
              <p className="empty-state">No messages yet</p>
            ) : (
              chatHistory.map((message, index) => {
                const normalizedMessage = normalizeChatMessage(message)

                return (
                  <div
                    key={`${normalizedMessage.role}-${normalizedMessage.timestamp ?? index}`}
                    className={`chat-message-row ${
                      normalizedMessage.role === 'user' ? 'user-row' : 'assistant-row'
                    }`}
                  >
                    <div
                      className={`chat-message ${
                        normalizedMessage.role === 'user' ? 'user-message' : 'assistant-message'
                      }`}
                    >
                      <div>{normalizedMessage.content}</div>
                      {normalizedMessage.timestamp ? (
                        <div className="message-timestamp">{formatTimestamp(normalizedMessage.timestamp)}</div>
                      ) : null}
                    </div>
                  </div>
                )
              })
            )}
            <div ref={chatEndRef} />
          </div>
          <form className="chat-form" onSubmit={handleSubmit}>
            <input
              type="text"
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              placeholder="Type a message..."
              className="chat-input"
            />
            <button type="submit" className="chat-submit">
              Send
            </button>
          </form>
        </section>
      </div>
    </div>
  )
}

export default App
