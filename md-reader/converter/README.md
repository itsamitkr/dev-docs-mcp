# Local file converter (for the Markdown Read-Aloud reader)

Converts PDF, Word, PowerPoint, Excel, HTML, images, and more into Markdown
using [Microsoft markitdown](https://github.com/microsoft/markitdown), so the
reader (`../index.html`) can play any file aloud.

## Run it

```powershell
# from this folder
./start-converter.ps1
```

That creates a `.venv`, installs dependencies, and starts the service on
`http://127.0.0.1:5000`. Leave the window open while you use the reader.

Manual alternative:

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python app.py
```

## How the reader uses it

1. Open `../index.html` in your browser.
2. Click **Open file** and pick a PDF/DOCX/PPTX/… (or drag it onto the page).
3. The reader uploads the file here, gets Markdown back, and plays it.

`.md`, `.markdown`, and `.txt` files skip the converter and load instantly, so
the reader still works without this service running.

## Notes

- Runs on localhost only. Don't expose it to the network.
- Conversion favors clean text/structure over exact page layout. Complex or
  scanned PDFs may come out rough.
- Endpoints: `GET /health`, `POST /convert` (multipart form field `file`).
