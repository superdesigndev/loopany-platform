#!/usr/bin/env python3
"""Seed a local loop with 100+ synthetic runs for UI testing.

Creates one loop (reusing the existing shared user/team/machine) and ~120 daily
exec runs with believable weather state, plus a few evolve/error/silent rows.
Idempotent-ish: pass --reset to delete a prior seeded loop of the same name.
"""
import argparse, json, math, os, sqlite3, uuid
from datetime import datetime, timedelta, timezone

DB = os.path.expanduser("~/.loopany/loopany.db")
LOOP_NAME = "上海每日天气播报（压测·120 runs）"

def iso(dt):  # ISO 8601 UTC with millis + Z, matching app format
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond//1000:03d}Z"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=120)
    ap.add_argument("--reset", action="store_true")
    args = ap.parse_args()

    con = sqlite3.connect(DB, timeout=15)
    con.execute("PRAGMA journal_mode=WAL;")
    cur = con.cursor()

    # reuse the existing scope so the loop shows up on the dashboard
    row = cur.execute(
        "SELECT id,user_id,team_id FROM machines LIMIT 1").fetchone()
    if not row:
        raise SystemExit("no machine in DB — connect a machine first")
    machine_id, user_id, team_id = row
    print(f"scope: machine={machine_id} user={user_id} team={team_id}")

    if args.reset:
        old = cur.execute("SELECT id FROM loops WHERE name=?", (LOOP_NAME,)).fetchall()
        for (lid,) in old:
            cur.execute("DELETE FROM runs WHERE loop_id=?", (lid,))
            cur.execute("DELETE FROM loops WHERE id=?", (lid,))
        if old:
            print(f"reset: removed {len(old)} prior loop(s) + their runs")

    now = datetime(2026, 6, 20, 7, 0, 0, tzinfo=timezone.utc)
    loop_id = f"loop-seed-{uuid.uuid4().hex[:12]}"
    state_schema = json.dumps([
        {"key": "tmax", "label": "最高温", "unit": "℃"},
        {"key": "tmin", "label": "最低温", "unit": "℃"},
        {"key": "precip", "label": "降水量", "unit": "mm"},
        {"key": "wind", "label": "风速", "unit": "km/h"},
    ], ensure_ascii=False)

    cur.execute(
        """INSERT INTO loops
           (id,user_id,team_id,machine_id,name,cron,timezone,task,workdir,
            state_schema,notify,allow_control,enabled,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (loop_id, user_id, team_id, machine_id, LOOP_NAME, "0 7 * * *",
         "Asia/Shanghai", "每天早上播报上海天气", None, state_schema,
         "auto", 0, 1, iso(now - timedelta(days=args.count)), iso(now)),
    )

    n = args.count
    rows = []
    for i in range(n):
        # day i counted back from today; oldest first
        day = now - timedelta(days=(n - 1 - i))
        ts = day.replace(hour=7, minute=(i * 7) % 60, second=(i * 11) % 60)
        # believable seasonal-ish weather via sine waves + per-day jitter
        season = math.sin((i / 30.0) * math.pi)
        jit = math.sin(i * 2.3) * 1.7
        tmax = round(26 + 6 * season + jit, 1)
        tmin = round(tmax - (5 + abs(math.sin(i * 1.1)) * 4), 1)
        precip = round(max(0.0, math.sin(i * 0.9) * 6 + (i % 5 == 0) * 4), 1)
        wind = round(8 + abs(math.cos(i * 0.7)) * 12, 1)
        state = json.dumps({"tmax": tmax, "tmin": tmin, "precip": precip, "wind": wind})

        role, phase, outcome, status, error = "exec", "done", "direct", None, None
        msg = (f"🌤️ 上海 {ts.strftime('%Y-%m-%d')}：{tmin}~{tmax}℃，"
               f"风速 {wind} km/h，降水 {precip} mm。")
        # sprinkle variety: every 17th run an evolve, every 23rd an error, every 13th silent
        if i and i % 17 == 0:
            role, outcome, msg = "evolve", "evolve", "🔧 演化：调整了播报措辞与降水阈值。"
            state = None
        elif i and i % 23 == 0:
            phase, outcome, error, msg = "error", "error", "claude exited 1: timeout fetching weather API", None
            state = None
        elif i and i % 13 == 0:
            outcome, status, msg = "silent", "nothing-new", None

        rows.append((
            str(uuid.uuid4()), loop_id, user_id, machine_id, phase, role, iso(ts),
            outcome, status, msg, 800 + (i * 37) % 2500, error,
            state,
        ))

    cur.executemany(
        """INSERT INTO runs
           (id,loop_id,user_id,machine_id,phase,role,ts,outcome,status,message,
            duration_ms,error,state)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        rows,
    )
    con.commit()
    total = cur.execute("SELECT count(*) FROM runs WHERE loop_id=?", (loop_id,)).fetchone()[0]
    print(f"✅ seeded loop {loop_id} with {total} runs ({LOOP_NAME})")
    con.close()

if __name__ == "__main__":
    main()
