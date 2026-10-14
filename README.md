# Voice Weekly Report

Record short voice notes during the week and receive an automatically generated, business-formal weekly report in four sections:

1. Achievements / Progress
2. Challenges Faced
3. Priorities for Next Week
4. Support Needed

No typing is required. Speech is transcribed **on the phone itself**, and the report is assembled automatically.

## Install on your phone

Open the app link in your phone's browser:

**https://YOUR-GITHUB-USERNAME.github.io/voice-weekly-report/**

| Platform | Steps |
|---|---|
| **Android** (Chrome) | Open the link, then tap **Install** in the banner, or open the menu (three dots) and tap **Install app** / **Add to Home screen**. |
| **iPhone / iPad** (Safari, iOS 16.4 or later) | Open the link in **Safari**, tap the **Share** button, then **Add to Home Screen**. |

After installation, the app opens full screen from the home screen like any other app and works offline.

On first use:

1. Enter your name and your first project.
2. Tap **Add to calendar** to set the Thursday reminder.
3. Record a note. The speech model (about 40 MB) downloads once, ideally over Wi-Fi. After that, transcription works offline.

## How it works

```
Microphone ─► Encrypted audio (on device) ─► Whisper speech-to-text (on device)
          ─► Layer 1: business-writing clean-up (on device, always)
          ─► Layer 2: AI business-writing editor (Claude, optional)
          ─► Weekly report ─► optional AI polish of final wording ─► Share / Email / PDF
```

| Component | Implementation |
|---|---|
| Recording | MediaRecorder API (WebM/Opus on Android, MP4/AAC on iOS), up to 5 minutes per note, with pause and resume |
| Speech-to-text | OpenAI Whisper (`whisper-tiny.en` or `whisper-base.en`) running in a Web Worker via Transformers.js 3.8.1 |
| Editing layer 1 (on device) | Removes fillers, false starts, repeated words, hedges and casual phrasing ("gonna", "touch base", "ASAP"), then sorts sentences into the four sections and rewrites them as short bullets |
| Editing layer 2 (optional) | Claude (`claude-opus-5-5`) rewrites each transcript into business-formal bullets: keeps every fact and the main idea, removes noise, turns incoherent passages into clear statements, keeps only self-corrected versions, and leaves out anything too garbled to understand rather than guessing. A weekly pass merges overlaps and applies later corrections. |
| Report generation | Deterministic rules that detect the four spoken prompts, remove filler words, rewrite sentences as concise bullets, merge duplicates and preserve project terminology |
| Storage | IndexedDB on the device |
| Reminder | A repeating calendar event every Thursday (default 17:00) with a follow-up alarm three hours later, added to the phone's own calendar (`.ics` or Google Calendar) |
| Offline | Service worker caches the app; the browser caches the speech model |

## AI business-writing editor (optional)

Turn it on in **Settings > AI business-writing editor**. If it is off, offline or unavailable, the on-device edit is used automatically, so a report is always produced.

- **New notes** are edited automatically after transcription. Existing notes show an **Edit with AI editor** button.
- **Weekly report**: **Polish final wording with AI** consolidates the week (merges duplicates, applies later corrections, at most 5 bullets per section). If notes change afterwards, the app asks you to polish again.
- **Safeguards**: project names, codes and key terms are re-applied after editing, and dashes are removed. The editor is instructed not to add facts.

### Connection options

| Option | When to use | Setup |
|---|---|---|
| **Team proxy (recommended)** | Rolling out to colleagues | Deploy `proxy/cloudflare-worker.js` once. Colleagues enter only the proxy URL and a team access code. The API key never reaches a phone. |
| **Personal API key** | Individual use or testing | Paste an Anthropic API key in Settings. It is stored encrypted on the device. |

**Deploying the team proxy (Cloudflare Workers, free tier):**

1. Create a Worker in the Cloudflare dashboard and paste in `proxy/cloudflare-worker.js`.
2. Under **Settings > Variables**, add the secrets `ANTHROPIC_API_KEY` and `TEAM_ACCESS_CODE`, and the variable `ALLOWED_ORIGINS` set to `https://<username>.github.io`.
3. Share the Worker URL (`https://<name>.<account>.workers.dev`) and the access code with colleagues.

The proxy accepts only text-editing requests from the app's site, requires the access code, pins the model and caps request size. The app's Content Security Policy allows `*.workers.dev` and `api.anthropic.com`. If you use a custom proxy domain, add it to `connect-src` in `index.html`.

## Security and privacy

- **Audio never leaves the device.** No analytics and no third-party tracking.
- **Transcripts stay on the device** unless the AI editor is turned on. In that case only transcript text (never audio) is sent to Anthropic for editing.
- **Encryption at rest:** each recording and transcript is encrypted with AES-256-GCM. The key is generated on the device as a non-extractable Web Crypto key.
- **Transport:** served over HTTPS by GitHub Pages. A strict Content Security Policy allows scripts only from this site and one pinned library version on jsDelivr.
- **Retention:** audio is deleted automatically after 90 days. Transcripts and reports remain until the user deletes them.
- **Network use:** to download the app files, the speech model (once, from Hugging Face) and, when the AI editor is on, the Anthropic SDK and the editing requests.
- **User control:** delete individual notes, or use **Settings > Delete all data on this device**.

Data is stored per device and per browser. Installing the app to the home screen protects it from automatic browser clean-up on iOS.

## User guidelines for voice notes

Structure each note around four prompts:

1. **"This week I achieved..."** Completed tasks, milestones and measurable progress.
2. **"The challenges were..."** Obstacles, delays or risks.
3. **"Next week I will..."** Top priorities.
4. **"I need support with..."** What help you need, and from whom. If none, say "No support needed."

Tips: select the correct project first, speak in complete sentences, say names and acronyms clearly, and keep each note under 3 minutes. Add key names to the project's **Key terms** in Settings so they are always spelled correctly.

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
