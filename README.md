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
          ─► Layer 2: AI business-writing editor (Claude, optional)
          ─► Weekly report ─► optional AI polish of final wording ─► Share / Email / PDF
```

| Component | Implementation |
|---|---|
| Recording | MediaRecorder API (WebM/Opus on Android, MP4/AAC on iOS), up to 5 minutes per note, with pause and resume |
| Speech-to-text | OpenAI Whisper (`whisper-tiny.en` or `whisper-base.en`) running in a Web Worker via Transformers.js 3.8.1 |
| Automatic project detection | No project or tag selection. The app finds the project(s) named in the note ("On the Edu Nexus project...", "Moving to Jusoor...", or a known project's name or code), splits a multi-project note into one entry per project, learns new project names, and matches later mentions even when mis-heard. Correcting a name in Settings teaches the app that spelling. |
| Editing layer 1 (on device) | Removes fillers, false starts, repeated words, hedges and casual phrasing ("gonna", "touch base", "ASAP"), then sorts sentences into the four sections and rewrites them as short bullets |
| Editing layer 2 (optional) | Claude (`claude-opus-5-5`) rewrites each transcript into business-formal bullets: keeps every fact and the main idea, removes noise, turns incoherent passages into clear statements, keeps only self-corrected versions, and leaves out anything too garbled to understand rather than guessing. A weekly pass merges overlaps and applies later corrections. |
| Report generation | Deterministic rules that detect the four spoken prompts, remove filler words, rewrite sentences as concise bullets, merge duplicates and preserve project terminology |
| Storage | IndexedDB on the device |
| Reminder | A repeating calendar event every Thursday (default 17:00) with a follow-up alarm three hours later, added to the phone's own calendar (`.ics` or Google Calendar) |
| Offline | Service worker caches the app; the browser caches the speech model |

## AI writing assistant (optional)

Turn it on in **Settings > AI writing assistant**, or tap **Connect** on the Home banner. If it is off, offline or unavailable, the on-device edit is used automatically, so a report is always produced.

### Team server (recommended for organisations)

The organisation's Gemini key and the AI prompts live in a small Google Apps Script web app owned by the admin. Phones never store or send an API key: they send only the note text and a team code. Admins can change the prompts at any time from the **Team admin** page without redeploying the app.

**One-time setup (admin, about 10 minutes):**

1. Go to [script.google.com](https://script.google.com), create a new project and replace the contents of `Code.gs` with [`server/apps-script/Code.gs`](server/apps-script/Code.gs).
2. **Project Settings > Script properties > Add script property**: `GEMINI_API_KEY` = a key from [Google AI Studio](https://aistudio.google.com/apikey). Use a key from a billing-enabled project for confidential work (paid tier: Google does not use the text to improve its products).
3. In the editor, select the function `setupTokens` and click **Run** (approve the permissions). Open **Execution log** to see the generated `TEAM_CODE` and `ADMIN_TOKEN`. Keep the admin token private.
4. **Deploy > New deployment > Web app**. Execute as: **Me**. Who has access: **Anyone**. Copy the web app URL (ends in `/exec`).
5. In the app, open **Settings > Team admin** (or `admin.html`), enter the URL and the admin token, and tap **Connect**.
6. Copy the **invite link** and send it to colleagues. Opening it on a phone connects the app automatically.

**Admin page:** edit the note analysis prompt and the weekly polish prompt, test a draft on a sample note before saving, see who changed the prompts and when, reset to the defaults, or restore the previous version. Output formats are fixed by the server, so prompt edits cannot break the app.

**Updating the server code later:** paste the new `Code.gs`, then **Deploy > Manage deployments > Edit > Version: New version > Deploy**. The URL stays the same.

### Google Gemini with your own key

1. Tap **Get your free Gemini key**. Google AI Studio opens; sign in with your Google account and tap **Create API key**, then copy it.
2. Back in the app, tap **Paste key and connect**.

The app uses the newest stable Gemini Flash model and falls back to older Flash models if needed. Privacy: on the **free** Gemini tier, Google may use submitted text to improve its products and human reviewers may read it. For confidential work, enable billing on the key's Google Cloud project (paid tier), where Google does not use prompts or responses to improve its products.

### Claude options

| Option | When to use | Setup |
|---|---|---|
| **Team proxy** | Organisation-wide rollout with one central key | Deploy `proxy/cloudflare-worker.js` once. Colleagues enter only the proxy URL and a team access code. The API key never reaches a phone. |
| **Personal API key** | Individual use or testing | Paste an Anthropic API key in Settings. It is stored encrypted on the device. |

**Deploying the team proxy (Cloudflare Workers, free tier):**

1. Create a Worker in the Cloudflare dashboard and paste in `proxy/cloudflare-worker.js`.
2. Under **Settings > Variables**, add the secrets `ANTHROPIC_API_KEY` and `TEAM_ACCESS_CODE`, and the variable `ALLOWED_ORIGINS` set to `https://amirelsawygethub.github.io`.
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
