# Khmer Dubbing Studio: deploy
1. Put this folder in a Git repo (or run `npx vercel` inside it).
2. Import it in Vercel as a plain project (no framework, no build command). `index.html` is the app, `api/tts.js` is the Edge TTS proxy.
3. Open the deployed URL > Settings. The TTS endpoint is `/api/tts` by default.
Notes: Edge TTS is an unofficial free service. Microsoft can change it without notice. Keep your deployment private if you do not want others using your proxy.
