# Voice Weekly Report

Record short voice notes during the week and receive an automatically generated, business-formal weekly report in four sections:

1. Achievements / Progress
2. Challenges Faced
3. Priorities for Next Week
4. Support Needed

No typing is required. Speech is transcribed **on the phone itself**, and the report is assembled automatically.

## Install on your phone

Open the app link in your phone's browser:

**https://amirelsawygethub.github.io/voice-weekly-report/**

| Platform | Steps |
|---|---|
| **Android** (Chrome) | Open the link, then tap **Install** in the banner, or open the menu (three dots) and tap **Install app** / **Add to Home screen**. |
| **iPhone / iPad** (Safari, iOS 16.4 or later) | Open the link in **Safari**, tap the **Share** button, then **Add to Home Screen**. |

After installation, the app opens full screen from the home screen like any other app and works offline.

On first use:

1. Enter your name. There is nothing else to set up: projects are detected from your notes.
2. Tap **Add to calendar** to set the Thursday reminder.
3. Record a note. The speech model (about 40 MB) downloads once, ideally over Wi-Fi. After that, transcription works offline.

## How it works

```
Microphone ─► Encrypted audio (on device) ─► Whisper speech-to-text (on device)
          ─► Automatic analysis: which project(s), and achievements / challenges / priorities / support
          ─► Layer 1: business-writing clean-up (on device, always)
          ─► Layer 2: AI writing assistant (your own Google Gemini key, optional)
          ─► Weekly report ─► optional AI polish of final wording ─► Share / Email / PDF
```

| Component | Implementation |
|---|---|
| Recording | MediaRecorder API (WebM/Opus on Android, MP4/AAC on iOS), up to 5 minutes per note, with pause and resume |
| Speech-to-text | OpenAI Whisper (`whisper-tiny.en` or `whisper-base.en`) running in a Web Worker via Transformers.js 3.8.1 |
| Automatic project detection | No project or tag selection. The app finds the project(s) named in the note ("On the Edu Nexus project...", "Moving to Jusoor...", or a known project's name or code), splits a multi-project note into one entry per project, learns new project names, and matches later mentions even when mis-heard. Correcting a name in Settings teaches the app that spelling. |
| Editing layer 1 (on device) | Removes fillers, false starts, repeated words, hedges and casual phrasing ("gonna", "touch base", "ASAP"), then sorts sentences into the four sections and rewrites them as short bullets |
| Editing layer 2 (optional) | With the user's own Gemini key, Gemini rewrites each transcript into business-formal bullets: keeps every fact and the main idea, removes noise, turns incoherent passages into clear statements, keeps only self-corrected versions, and leaves out anything too garbled to understand rather than guessing. A weekly pass merges overlaps and applies later corrections. Requests go directly from the phone to Google. |
| Report generation | Deterministic rules that detect the four spoken prompts, remove filler words, rewrite sentences as concise bullets, merge duplicates and preserve project terminology |
| Storage | IndexedDB on the device |
| Reminder | A repeating calendar event every Thursday (default 17:00) with a follow-up alarm three hours later, added to the phone's own calendar (`.ics` or Google Calendar) |
| Offline | Service worker caches the app; the browser caches the speech model |

## AI writing assistant (optional, your own Google Gemini key)

The app always edits notes on the device. Each person can optionally connect **their own** free Gemini key for sharper wording:

1. In **Settings > AI writing assistant**, turn on **Use my own Gemini key** (or tap **Connect** on the Home banner).
2. Tap **Get your free Gemini key**: Google AI Studio opens; sign in with any Google account, tap **Create API key** and copy it.
3. Back in the app, tap **Paste key and connect**.

Requests go **directly from the phone to Google**, under that person's own Google account, quota and terms. No server run by the app owner or any organisation is involved, and no shared key exists that could be misused if the app is shared widely. If the assistant is off, offline or unavailable, the on-device edit is used.

The app uses Gemini 3.5 Flash-Lite (about 1 to 4 seconds per note) and falls back to other Flash models if needed. Privacy: on the **free** Gemini tier, Google may use submitted text to improve its products and human reviewers may read it. For confidential work, use a key from a billing-enabled Google Cloud project (paid tier), where Google does not use prompts or responses to improve its products.

## Security and privacy

- **Audio never leaves the device.** No analytics and no third-party tracking.
- **Transcripts stay on the device** unless the person connects their own Gemini key. Then only transcript text (never audio) goes directly from the phone to Google.
- **Encryption at rest:** each recording and transcript is encrypted with AES-256-GCM. The key is generated on the device as a non-extractable Web Crypto key.
- **No third-party code at runtime:** the speech library (Transformers.js 3.8.1 and its ONNX runtime) is hosted inside the app, copied from the official npm package after verifying its integrity hash (see `vendor/transformers/SOURCE.md`).
- **Transport and connections:** served over HTTPS by GitHub Pages. A strict Content Security Policy allows scripts only from this site, and network connections only to this site, Google's Gemini API and the Hugging Face speech model download.
- **No central server:** nothing in the app connects to a server run by the app owner, a university or any organisation, so sharing the app widely creates no load or risk for anyone's servers.
- **Retention:** audio is deleted automatically after 90 days. Transcripts and reports remain until the user deletes them.
- **Network use:** to download the app files, the speech model (once, from Hugging Face) and, when a person connects their own Gemini key, their editing requests to Google.
- **User control:** delete individual notes, or use **Settings > Delete all data on this device**.

Data is stored per device and per browser. Installing the app to the home screen protects it from automatic browser clean-up on iOS.

## Typing a note and correcting transcripts

- **Type a note**: on Home (or from the record screen), tap **Prefer typing? Type a note**. Typed notes are analysed exactly like voice notes. On a note, **Add by typing** appends text.
- **Review before reporting**: after a voice note is transcribed it is marked **Needs review** and is not added to the weekly report until confirmed. Tap **Looks good, add to report**, or **Correct transcript** to fix misheard names or numbers while listening to the recording. The note is rebuilt from the corrected text. Transcripts can be corrected again at any time from the note.
- Correcting a project name teaches the app the right spelling; later notes that mishear it are filed under the corrected name.

## User guidelines for voice notes

Just speak naturally; nothing needs to be selected. For the best results, name the project as you start, say "Moving to..." before switching to another project, and cover whatever applies of:

1. **"This week I achieved..."** Completed tasks, milestones and measurable progress.
2. **"The challenges were..."** Obstacles, delays or risks.
3. **"Next week I will..."** Top priorities.
4. **"I need support with..."** What help you need, and from whom. Skip it if none.
5. **"We are waiting on..." / "...depends on..."** Dependencies, if any: inputs, approvals or deliverables your work is waiting on, and anyone waiting on you. They appear under Challenges (or Support when you ask for help to unblock them).

Tips: speak in complete sentences, say names and acronyms clearly, and keep each note under 3 minutes. Sections with nothing reported are left out of the report. Add key names to a project's **Key terms** in Settings so they are always spelled correctly.

## Deploying (GitHub Pages)

The app is static files only. No build step is needed.

1. Push this folder to a GitHub repository.
2. In the repository, go to **Settings > Pages**.
3. Under **Build and deployment**, select **Deploy from a branch**, choose `main` and `/ (root)`, then **Save**.
4. The app is published at `https://<username>.github.io/<repository>/` within a minute or two.

To run it locally: `python3 -m http.server 8000`, then open `http://localhost:8000`.

## Known limitations

- Transcription accuracy depends on audio quality. Use **Settings > Accuracy > High** for better recognition at the cost of a larger download and slower processing.
- The current version supports English speech. Arabic is planned for a later phase.
- Reminders rely on the phone calendar, which is the most reliable cross-platform option without a server.
