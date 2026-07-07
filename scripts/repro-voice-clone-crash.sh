#!/usr/bin/env bash
# Repro: uploading a (short, synthetic) reference sample as a custom voice, then
# synthesizing with it, crashes the vLLM-omni EngineCore.
#
# Environment observed: vllm-omni serving Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
# Result observed:
#   step 3 -> HTTP 500 {"error":{"message":"EngineCore encountered an issue. ..."}}
#   afterwards the whole server is unreachable (/health times out) => engine died.
#
# Usage: BASE=http://127.0.0.1:63336 bash scripts/repro-voice-clone-crash.sh

set -x
BASE="${BASE:-http://127.0.0.1:63336}"
VOICE_NAME="${VOICE_NAME:-test_clone}"

# 0) sanity: server up, list voices
curl -s -m 10 "$BASE/health" -o /dev/null -w 'health: %{http_code}\n'
curl -s -m 10 "$BASE/v1/audio/voices"; echo

# 1) create the reference sample with a built-in voice
#    (2.4s, WAV 24kHz mono Int16, ~115KB — exactly what the server itself produces)
curl -s -m 120 -X POST "$BASE/v1/audio/speech" \
  -H 'content-type: application/json' \
  -d '{"input":"你好，欢迎来到多模态暗房","voice":"vivian","response_format":"wav"}' \
  -o /tmp/ref-sample.wav -w 'gen ref: %{http_code}, %{size_download} bytes\n'

# 2) upload it as a custom voice  —— this step succeeds
curl -s -m 60 -X POST "$BASE/v1/audio/voices" \
  -F "name=$VOICE_NAME" \
  -F 'consent=true' \
  -F 'audio_sample=@/tmp/ref-sample.wav;type=audio/wav' \
  -F 'ref_text=你好，欢迎来到多模态暗房'
echo

# 3) synthesize with the cloned voice  —— this crashes the engine
curl -s -m 120 -X POST "$BASE/v1/audio/speech" \
  -H 'content-type: application/json' \
  -d "{\"input\":\"这是用克隆音色合成的一句话\",\"voice\":\"$VOICE_NAME\",\"response_format\":\"wav\"}" \
  -o /tmp/clone-out.wav -w 'clone speech: %{http_code}, %{size_download} bytes\n'
head -c 300 /tmp/clone-out.wav; echo

# 4) is the server still alive? (observed: no — connection refused/timeout)
curl -s -m 10 "$BASE/health" -o /dev/null -w 'health after: %{http_code}\n'

# 5) cleanup (only reachable if the server survived)
curl -s -m 10 -X DELETE "$BASE/v1/audio/voices/$VOICE_NAME" -w 'delete: %{http_code}\n'
