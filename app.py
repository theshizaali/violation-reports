"""Obvio Reports - a small app for submitting traffic violations with a bounding box."""
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone

from flask import Flask, abort, g, jsonify, request, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
DB_PATH = os.path.join(BASE_DIR, "reports.db")

VIOLATION_TYPES = {
    "stop_sign": "Stop sign violation",
    "red_light": "Red light violation",
    "crosswalk": "Failure to yield at crosswalk",
    "speeding": "Speeding / school zone",
    "distracted": "Distracted driving",
    "other": "Other unsafe driving",
}
ALLOWED_EXT = {
    ".jpg": "image", ".jpeg": "image", ".png": "image", ".webp": "image", ".gif": "image",
    ".mp4": "video", ".mov": "video", ".webm": "video",
}

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB

os.makedirs(UPLOAD_DIR, exist_ok=True)


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    with sqlite3.connect(DB_PATH) as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                violation_type TEXT NOT NULL,
                description TEXT,
                location TEXT,
                latitude REAL,
                longitude REAL,
                media_file TEXT NOT NULL,
                media_kind TEXT NOT NULL,
                bbox TEXT NOT NULL,
                video_time REAL
            )"""
        )


def parse_bbox(raw):
    """Bounding box is {x, y, w, h} as fractions (0-1) of the media's width/height."""
    try:
        box = json.loads(raw)
        vals = {k: float(box[k]) for k in ("x", "y", "w", "h")}
    except (TypeError, ValueError, KeyError):
        return None
    if not (0 <= vals["x"] <= 1 and 0 <= vals["y"] <= 1 and vals["w"] > 0 and vals["h"] > 0):
        return None
    if vals["x"] + vals["w"] > 1.0001 or vals["y"] + vals["h"] > 1.0001:
        return None
    return vals


def optional_float(name):
    val = request.form.get(name, "").strip()
    if not val:
        return None
    try:
        return float(val)
    except ValueError:
        abort(400, f"{name} must be a number")


def row_to_dict(row):
    d = dict(row)
    d["bbox"] = json.loads(d["bbox"])
    d["violation_label"] = VIOLATION_TYPES.get(d["violation_type"], d["violation_type"])
    d["media_url"] = f"/uploads/{d.pop('media_file')}"
    return d


@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(413)
def json_error(err):
    msg = getattr(err, "description", str(err))
    if err.code == 413:
        msg = "File is too large (max 50 MB)."
    return jsonify(error=msg), err.code


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/violation-types")
def violation_types():
    return jsonify(VIOLATION_TYPES)


@app.get("/api/reports")
def list_reports():
    vtype = request.args.get("type")
    sql = "SELECT * FROM reports"
    params = []
    if vtype:
        sql += " WHERE violation_type = ?"
        params.append(vtype)
    sql += " ORDER BY created_at DESC"
    rows = get_db().execute(sql, params).fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.post("/api/reports")
def create_report():
    file = request.files.get("media")
    if not file or not file.filename:
        abort(400, "Please attach a photo or video.")
    ext = os.path.splitext(file.filename)[1].lower()
    kind = ALLOWED_EXT.get(ext)
    if not kind:
        abort(400, "Unsupported file type. Use JPG, PNG, WEBP, GIF, MP4, MOV or WEBM.")

    vtype = request.form.get("violation_type", "")
    if vtype not in VIOLATION_TYPES:
        abort(400, "Choose a violation type.")

    bbox = parse_bbox(request.form.get("bbox"))
    if bbox is None:
        abort(400, "Draw a box around where the violation happened.")

    lat, lng = optional_float("latitude"), optional_float("longitude")
    video_time = optional_float("video_time") if kind == "video" else None

    report_id = uuid.uuid4().hex
    filename = f"{report_id}{ext}"
    file.save(os.path.join(UPLOAD_DIR, filename))

    db = get_db()
    db.execute(
        """INSERT INTO reports (id, created_at, violation_type, description, location,
           latitude, longitude, media_file, media_kind, bbox, video_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            report_id,
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
            vtype,
            request.form.get("description", "").strip()[:1000],
            request.form.get("location", "").strip()[:200],
            lat,
            lng,
            filename,
            kind,
            json.dumps(bbox),
            video_time,
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.delete("/api/reports/<report_id>")
def delete_report(report_id):
    db = get_db()
    row = db.execute("SELECT media_file FROM reports WHERE id = ?", (report_id,)).fetchone()
    if not row:
        abort(404, "Report not found.")
    db.execute("DELETE FROM reports WHERE id = ?", (report_id,))
    db.commit()
    try:
        os.remove(os.path.join(UPLOAD_DIR, row["media_file"]))
    except FileNotFoundError:
        pass
    return "", 204


@app.get("/uploads/<path:filename>")
def uploads(filename):
    return send_from_directory(UPLOAD_DIR, filename)


DEMO_REPORTS = [
    {
        "file": "stop-sign.jpg",
        "violation_type": "stop_sign",
        "bbox": {"x": 0.322, "y": 0.548, "w": 0.442, "h": 0.228},
        "location": "Clarendon Ave & Panorama Dr",
        "description": "Orange coupe rolled through the all-way stop without stopping.",
        "latitude": 37.7531,
        "longitude": -122.4560,
    },
    {
        "file": "red-light.jpg",
        "violation_type": "red_light",
        "bbox": {"x": 0.43, "y": 0.725, "w": 0.335, "h": 0.12},
        "location": "Le Loi Ave & Hung Vuong St",
        "description": "SUV and two scooters entered the intersection after the light turned red.",
        "latitude": None,
        "longitude": None,
    },
]


def seed_demo():
    """When SEED_DEMO=1 and there are no reports, add sample reports.

    Free hosting tiers wipe the disk on restart, so this keeps a live demo from looking empty.
    """
    if os.environ.get("SEED_DEMO") != "1":
        return
    import shutil

    with sqlite3.connect(DB_PATH) as db:
        if db.execute("SELECT COUNT(*) FROM reports").fetchone()[0]:
            return
        for r in DEMO_REPORTS:
            report_id = uuid.uuid4().hex
            filename = f"{report_id}.jpg"
            shutil.copy(os.path.join(BASE_DIR, "demo", r["file"]), os.path.join(UPLOAD_DIR, filename))
            db.execute(
                """INSERT INTO reports (id, created_at, violation_type, description, location,
                   latitude, longitude, media_file, media_kind, bbox, video_time)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'image', ?, NULL)""",
                (
                    report_id,
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    r["violation_type"],
                    r["description"],
                    r["location"],
                    r["latitude"],
                    r["longitude"],
                    filename,
                    json.dumps(r["bbox"]),
                ),
            )


init_db()
seed_demo()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    app.run(host="127.0.0.1", port=port, debug=True)
