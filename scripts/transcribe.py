"""Local transcription with openai-whisper (runs on this machine; nothing is uploaded).
usage: transcribe.py <audio.wav> <out.json> <model> <language|auto>
Writes {"language": "...", "segments": [{"start": s, "end": s, "text": "..."}]}. Exit code 2 = whisper not installed.
"""
import json
import sys

try:
    import whisper  # type: ignore
except Exception as e:  # pragma: no cover
    sys.stderr.write("whisper-not-installed: %s\n" % e)
    sys.exit(2)

audio, out, model_name, lang = sys.argv[1:5]
model = whisper.load_model(model_name)
opts = {"fp16": False, "verbose": None, "condition_on_previous_text": False}
if lang and lang != "auto":
    opts["language"] = lang
res = model.transcribe(audio, **opts)
segs = [{"start": float(s["start"]), "end": float(s["end"]), "text": s["text"].strip()} for s in res.get("segments", []) if s["text"].strip()]
with open(out, "w", encoding="utf-8") as f:
    json.dump({"language": res.get("language"), "segments": segs}, f, ensure_ascii=False)
