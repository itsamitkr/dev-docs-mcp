"""
Local file-to-Markdown converter for the Markdown Read-Aloud reader.

Accepts a file upload and returns Markdown produced by Microsoft's markitdown
(https://github.com/microsoft/markitdown). Runs on localhost only; the browser
reader (index.html) posts files here and plays the converted Markdown.

Run:
    pip install -r requirements.txt
    python app.py
Then open ../index.html and use "Open file".
"""

import os
import tempfile

from flask import Flask, request, jsonify
from flask_cors import CORS
from markitdown import MarkItDown

app = Flask(__name__)
# Allow the reader to call us whether it's opened from file:// (origin "null")
# or served from another localhost port.
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024  # 64 MB upload cap

md = MarkItDown()


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.post("/convert")
def convert():
    if "file" not in request.files:
        return jsonify(error="No file uploaded (expected form field 'file')."), 400

    upload = request.files["file"]
    if not upload.filename:
        return jsonify(error="Empty filename."), 400

    suffix = os.path.splitext(upload.filename)[1]
    tmp_path = None
    try:
        # markitdown reads from a path; stream the upload to a temp file first.
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            upload.save(tmp.name)
            tmp_path = tmp.name

        result = md.convert(tmp_path)
        return jsonify(name=upload.filename, markdown=result.text_content or "")
    except Exception as exc:  # surface a readable message to the reader
        return jsonify(error="Conversion failed: {}".format(exc)), 500
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    # Bind to localhost only — this is a personal, local tool.
    app.run(host="127.0.0.1", port=5000, debug=False)
