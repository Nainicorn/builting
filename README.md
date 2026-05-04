# builting

> Unstructured data in. IFC 3D model out.

> **Note for reviewers / debug helpers**: This is a snapshot of the in-progress codebase shared for a second pair of eyes. The active issue list and current pipeline phase live in `CLAUDE.md` (see "Pipeline Engineering Principles" + the project memory in `.claude/projects/.../memory/`). The reference target IFC for tunnel renders is `sample/final.ifc`. Backend lambdas under `backend/lambda-functions/` are the most active surface area — `builting-extract`, `builting-resolve`, `builting-topology-engine`, and `builting-generate` are where most current work is happening. Lambda zips, layer artifacts, and `node_modules` are gitignored — run `npm install` in the repo root and inside each lambda dir before working locally.

**builting** is a full-stack AI pipeline that transforms raw, unstructured building data — text descriptions, PDFs, blueprints, images — into production-grade IFC 3D models viewable directly in the browser or downloadable for use in tools like Revit.

The goal: give anyone the ability to generate a digital twin of a building or structure without needing to know BIM software.

---

## What it does

1. **Upload anything** — paste text, upload PDFs, drop in blueprint images or DXF files
2. **AI extraction** — Claude (via AWS Bedrock) reads and interprets the raw content, extracting structured building specs: walls, slabs, columns, MEP systems, rooms, and more
3. **Topology resolution** — a multi-stage inference engine snaps wall endpoints, infers openings, derives roof elevations, and assembles a topologically valid building model
4. **IFC generation** — a Python container converts the resolved geometry into a standards-compliant IFC4 file with proper BIM semantics, property sets, and spatial hierarchy
5. **View in browser** — the built-in xeokit-powered IFC viewer renders the model instantly; download as IFC, glTF, or OBJ

---

## Architecture

```
Browser (Vanilla JS + Handlebars)
        │
        ▼
API Gateway → builting-router (auth, session, presigned URLs)
        │
        ▼
Step Functions state machine
        │
   ┌────┴────────────────────────────────────┐
   │                                         │
builting-read         builting-extract (Node.js)
   │                    └─ Bedrock (Claude Sonnet)
   │                    └─ DXF / PDF / XLSX / DOCX parsers
   │                    └─ Multi-page PDF rasterization
   ▼
builting-resolve      (NormalizeClaims → ResolveClaims → canonical IDs)
   ▼
builting-topology-engine  (geometry inference, wall snapping, slab alignment)
   ▼
builting-generate     (Python 3.11 container → IFC4 + glTF + OBJ)
   ▼
builting-store        (DynamoDB + S3)
   ▼
builting-sensors      (simulated live IoT sensor data per render)
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS (ES6 modules), Handlebars, CSS (native nesting) |
| Dev server | Vite |
| 3D viewer | xeokit SDK |
| Backend compute | AWS Lambda (Node.js 20 + Python 3.11 container) |
| Orchestration | AWS Step Functions |
| AI model | Claude Sonnet via AWS Bedrock |
| Database | DynamoDB |
| File storage | S3 |
| Auth | HMAC-signed tokens (scrypt-hashed passwords) |
| Infrastructure | AWS GovCloud (us-gov-east-1) |

---

## Project structure

```
builting/
├── ui/
│   ├── components/         # One folder per component (hbs + js + css)
│   │   ├── login/
│   │   ├── layout/
│   │   ├── header/
│   │   ├── sidebar/
│   │   ├── renderbox/
│   │   ├── details/
│   │   └── ifc-viewer/
│   ├── services/           # API, auth, state, cookie, upload, sensor
│   ├── framework/          # Message/event bus
│   └── main.js             # Entry point
├── backend/
│   └── lambda-functions/
│       ├── builting-router/
│       ├── builting-read/
│       ├── builting-extract/
│       ├── builting-resolve/
│       ├── builting-topology-engine/
│       ├── builting-generate/
│       ├── builting-store/
│       └── builting-sensors/
└── ifc/                    # Test IFC files
```

---

## Running locally

```bash
# Install dependencies
npm install

# Set environment variables
cp .env.example .env.local
# → fill in VITE_API_BASE_URL with your API Gateway URL

# Start dev server
npm run dev
# → http://localhost:5001
```

The frontend is fully decoupled from the backend — point `VITE_API_BASE_URL` at any deployed instance.

---

## Pipeline engineering notes

- All pipeline fixes are universal — no per-render-type hacks in generate; problems are fixed upstream in extract/resolve/topology
- Per-element resilience — a single bad element never degrades the whole model; failures are proxied and isolated
- Z-placement is always storey-relative in generate — no reliance on absolute Z flags
- Wall endpoint coincidence is enforced in topology-engine before generate ever sees the data
- Validation annotates elements with actionable flags, not just a report
