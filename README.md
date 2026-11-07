# Community Violation Reports

A small web app that lets residents report unsafe driving. They upload a photo or video and draw a **bounding box** around where the violation happened.

## Features
- Upload a photo or video (JPG, PNG, MP4, WEBM, MOV, up to 50 MB).
- Drag a box over the violation. For videos, pause on the moment first; the timestamp is saved with the box.
- Pick a violation type: stop sign, red light, crosswalk, speeding, distracted driving or other. Add an optional location and description, or fill in the location from the browser's location.
- A reports feed shows each report with its box drawn over the media. You can filter by violation type, jump to the marked moment in a video, open a report on a map and delete reports.

## Run it locally
Requires Python 3.9 or newer.

```bash
pip3 install -r requirements.txt
python3 app.py
```

Then open http://127.0.0.1:5050.

The app creates `reports.db` (SQLite) and an `uploads/` folder on first run.

## How it works
- **Backend:** `app.py` is a Flask app with a small JSON API.
  - `POST /api/reports`: submit a report.
  - `GET /api/reports?type=...`: list reports, optionally filtered by type.
  - `DELETE /api/reports/<id>`: delete a report.
- **Frontend:** `static/` holds plain HTML, CSS and JavaScript with no build step. The box is stored as fractions (0–1) of the media's width and height, so it lines up at any screen size.
- **Validation:** The server checks the file type, the violation type and that the box lies inside the frame.

## Not production-ready
- There is no login, so anyone can submit or delete reports.
- Each report holds one box.
- Files are stored on local disk.

## Test footage
Free traffic clips are available on [Pexels](https://www.pexels.com/search/videos/traffic%20intersection/), [Pixabay](https://pixabay.com/videos/search/traffic/) and [Mixkit](https://mixkit.co/free-stock-video/vehicle/).
