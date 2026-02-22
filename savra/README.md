# Savra

Principal analytics dashboard for teacher activity data. Built with FastAPI on the backend and Next.js on the frontend.

---

## Architecture

```
savra/
├── Savra_Teacher Data Set-1 copy.xlsx   ← source data
├── backend/
│   ├── main.py           ← FastAPI, data layer, all API endpoints
│   ├── requirements.txt
│   └── vercel.json       ← serverless config for Vercel
└── frontend/
    ├── app/
    │   ├── page.tsx                  ← landing + auth
    │   └── dashboard/
    │       ├── layout.tsx            ← auth guard + sidebar
    │       ├── page.tsx              ← overall analytics
    │       ├── leaderboard/page.tsx
    │       ├── teachers/page.tsx
    │       └── grades/page.tsx
    ├── components/Sidebar.tsx
    └── vercel.json
```

**Backend** is a single-file FastAPI app. Data is read from Excel on every request with mtime-based caching — the dataframe is only reloaded when the file changes, so there is no startup cost on warm requests and no stale data after an update.

Duplicate rows are dropped at load time via `df.drop_duplicates()`, so the dataset is always clean regardless of what the source file contains.

Scores are normalised across all teachers using min-max scaling to a 0–10 range. If all teachers have identical raw scores, everyone is assigned 5.0.

**Frontend** is a Next.js app with a client-side auth layer using `sessionStorage`. A route guard in `dashboard/layout.tsx` redirects unauthenticated users to the landing page. No auth state is shared server-side.

---

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/leaderboard` | All teachers ranked by normalised score |
| GET | `/api/teachers` | Name + ID list |
| GET | `/api/teacher/{name}` | Full breakdown: score, grades, subjects, timeline, activity counts |
| GET | `/api/grades` | All grade levels |
| GET | `/api/grade/{grade}` | Assessments and teacher contributions for a grade |
| GET | `/api/overall` | School-wide stats, charts data, top teacher |

---

## Running locally

```bash
# activate virtualenv
source venv/bin/activate

# backend (port 8000)
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# frontend (port 3000) — new terminal
cd frontend
npm run dev
```

Open **http://localhost:3000**

Default login credentials:

| Username | Password |
|----------|----------|
| `admin` | `savra2024` |
| `principal` | `savra@school` |

---

## Deploying to Vercel

Vercel does not support a persistent filesystem for serverless functions, so the Excel file must be committed to the repository. Each deployment repackages the file alongside the Python code.

### Backend

1. New Project → import `savra` repo → set **Root Directory** to `backend`
2. Framework: **Other**
3. Deploy and copy the URL (e.g. `https://savra-api.vercel.app`)

### Frontend

1. New Project → import `savra` repo → set **Root Directory** to `frontend`
2. Framework: **Next.js** (auto-detected)
3. Add environment variable: `NEXT_PUBLIC_API_URL` = your backend URL
4. Deploy

---

## Scalability notes

**Data source**: The Excel file works well at this scale. Migrating to PostgreSQL or a read replica would be the natural next step — `load_data` and `get_df` are the only two functions that touch the data layer, so swapping the source requires changes in one place.

**Caching**: The current mtime cache is in-process and per-instance. Under multiple Vercel serverless instances this means each cold start reads the file independently. A shared cache layer (Redis, Upstash) would fix this with minimal changes since `get_df` is already isolated.

**Scoring**: The normalised score formula weights assessments at 60% and lessons at 40%. Both constants are at the top of `compute_leaderboard` and straightforward to expose as admin-configurable via a settings endpoint.

**Auth**: `sessionStorage` is intentional for this audience (single-device, browser-tab lifetime). Moving to JWT tokens with an `/auth/login` endpoint would be the first step for multi-device or persistent sessions.
