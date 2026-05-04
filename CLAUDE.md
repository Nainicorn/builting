# Text-to-3D Project — Architecture & Reference

**Active Plan**: See `PLAN.md` for the current tunnel IFC fix plan — read it at the start of every session, work through fixes in order, and move completed items to the "Completed Fixes" section.

**Constraints**
- completed.md should contain everything that has been implemented, phases, tasks, & detailed information about the project
- Separate each task into sub-tasks if needed and only after completion, move to the next task (go step by step)
- Use plan mode everytime you plan out the next phase or tasks
- Claude handles deployment: zip, push image, deploy all lambdas, and any AWS changes via AWS CLI (profile: `leidos`, region: `us-gov-east-1`)
- Claude can check CloudWatch logs for any lambda: `aws logs tail /aws/lambda/builting-<name> --since 30m --region us-gov-east-1 --profile leidos`
- **ALWAYS wipe the S3 IFC cache after deploying ANY pipeline lambda** (not just generate): `aws s3 rm s3://builting-ifc/cache/ --recursive --region us-gov-east-1 --profile leidos` — the generate lambda caches IFC files by CSS hash, so code changes won't take effect until the cache is cleared
- **Reference tunnel IFC**: `sample/final.ifc` — engineer-built in Revit, the target output for tunnel renders. Compare generated IFC against this visually and by entity counts.

**Pipeline Engineering Principles**
- All pipeline changes must be universal — no render-type-specific hacks in generate. Fix problems upstream in extract/structure/geometry.
- Per-element resilience — never degrade the entire model for one bad element. Proxy individual failures, preserve everything else.
- Keep lambda functions lean — decompose monoliths into focused modules. No single file should exceed ~1,000 lines.
- Z-placement is always storey-relative in generate — auto-detect and normalize, no reliance on placementZIsAbsolute flag.
- Wall endpoint coincidence is a structure-lambda responsibility — walls must share exact endpoints before reaching generate.
- Validation must annotate elements with actionable flags — not just write a report that gets ignored.
- Test every change against multiple render types (tunnel, hospital, office, warehouse) before deploying.

---

## Project Overview

A full-stack application that extracts large amounts of raw unstructured building information modeling (BIM) content from plaintext, images, blueprints, sensors, PDFs, etc. and generates a 3D model file (IFC format) viewable in the built-in frontend interface via a web IFC viewer or downloadable for use in 3D modeling tools such as Revit. The goal is to create a digital twin of a building or structure and all of its functional components. The tech stack uses a no-framework approach with vanilla JavaScript, HTML/Handlebars, and CSS on the frontend, with the entire backend configured through AWS GovCloud.

## Codebase Overview

The `backend` folder contains the most recent code identical to the current setup of AWS at any given time. The `ui` folder contains all frontend components (structure and style) and connections to the backend; it uses an ES6+ module-based folder/file structure. The `ifc` folder holds test files used during render testing. The goal is to keep the codebase extremely clean and easy to understand and navigate.

---

## AWS GovCloud Environment

| Resource | Value |
|---|---|
| **Account** | 008368474482 (GovCloud) |
| **Region** | us-gov-east-1 |
| **ARN prefix** | `arn:aws-us-gov` |
| **CLI profile** | `leidos` |

---

## Core Flow

- User login
    - DynamoDB `builting-users` table stores user records (password is scrypt-hashed)
    - User is authorized via HMAC-signed tokens (`userId.timestamp.hmac`) sent as `Authorization: Bearer` header; centralized auth gate in builting-router

- User home page (header, renderbox, sidebar)
    - Logout button in header redirects back to login screen
    - Sidebar collapse button in header collapses the sidebar for more renderbox real-estate
    - Start new render
        - Click "new render +" button or use the default renderbox prompt at login
        - Upload files from local machine (.txt, .pdf, .img); text typed in the renderbox input is auto-converted to .txt and bundled with uploads
        - Files are uploaded to S3 bucket `builting-data` via presigned URLs
        - A loading state appears until the IFC file is generated; the frontend then renders it in the IFC viewer along with AI-generated title, description, source file list, and a download button
    - View old renders in the sidebar
        - Each render card shows the title and a 3D static preview image
        - Clicking a card loads the render details: AI-generated title, description, source files, IFC viewer, and download/delete actions
        - IFC file is retrieved from S3 bucket `builting-ifc`

---

## UI Architecture

- **Components**
   - `login` — Login/signup form for user authentication
   - `layout` — Main app container that initializes all child components (header, sidebar, renderbox, details)
   - `header` — Top navigation bar with user name display, logout button, and sidebar toggle
   - `sidebar` — Displays user's previous renders as cards; contains "new render" button via controls component
   - `controls` — "New render" button that triggers the upload interface
   - `renderbox` — Main workspace for file uploads, render processing display, and active render viewing
   - `details` — Side panel showing selected render metadata, AI-generated title/description, source files, and download/delete actions
   - `ifc-viewer` — 3D viewer component using xeokit SDK to display and interact with IFC models
- `main.js` — Entry point that routes to login or layout based on authentication status
- **Framework**
   - `messages.js` — Message/event handling system
- **Services**
   - `authService` — Login/signup and session management; stores token in cookie, user in userStore
   - `aws` — HTTP wrapper for authenticated API calls to API Gateway with Bearer token auth
   - `cookieService` — Low-level cookie operations (set, get, delete) for session persistence
   - `rendersService` — Fetch user's renders, get render details, download IFC, delete renders
   - `uploadService` — Request presigned S3 URLs and upload files/descriptions directly to S3
   - `usersService` — Fetch current user data and user info from backend
   - `userStore` — Client-side state manager for current user (session in memory + localStorage backup)
- **Dev server**: Vite on port 5001

---

## Backend Architecture

### DynamoDB Tables

- **builting-users** — user accounts
   - PK: `id` (String), GSI: `email-index`
   - Fields: id, created_at, email, name, password (scrypt-hashed)
   - Test users:
      | id | name | email | password (plaintext) |
      |---|---|---|---|
      | user-1 | Sreenaina | skoujal@gmu.edu | Bujji1125$ |
      | user-2 | Gesu | gmahmads@gmu.edu | builting |
      | user-3 | Ibrahim | ihassane@gmu.edu | builting |
      | user-4 | Tamanno | talimova@gmu.edu | builting |

- **builting-renders** — per-user render records
   - PK: `user_id` (String), SK: `render_id` (String)
   - Fields: ai_generated_description, ai_generated_title, created_at, description, ifc_s3_path, s3_path, source_files, status

### Lambda Functions

Pipeline order: **router -> read -> extract -> resolve -> topology-engine -> generate -> store**

All functions run on arm64 and share `builting-role`.

| Function | Runtime | Notes |
|---|---|---|
| **builting-router** | Node.js 20 | API Gateway router for auth, user data, renders, presigned URLs, finalize (starts Step Function). ENV: STATE_MACHINE_ARN, SESSION_SECRET, ALLOWED_ORIGINS |
| **builting-read** | Node.js 20 | Retrieves render from DynamoDB and lists uploaded files from S3 |
| **builting-extract** | Node.js 20 (esbuild-bundled, 512MB) | Downloads files from S3, extracts building specs as CSS v1.0 via Bedrock (Claude Sonnet 4.5) + VentSim/DXF/XLSX/DOCX parsers + multi-pass extraction + enrichment; dual-writes claims.json alongside css_raw.json; title block extraction (bottom-right crop + fallback), page role classification, coordinate-bearing prompts, spatial layout assembly, multi-page PDF (up to 5 pages rasterized via mupdf), scale calibration, dedicated scale bar extraction, vision-to-BuildingSpec bridge, component-based confidence model; image tiling for sheets >3500px (multi-image Bedrock call), PDF text layer injection as context, sharp for image crop/tile |
| **builting-resolve** | Node.js 20 | NormalizeClaims + ResolveClaims — reads claims.json, normalizes units/conventions, groups by subject identity, resolves field conflicts, assigns canonical IDs, writes normalized_claims.json + canonical_observed.json + resolution_report.json + identity_map.json |
| **builting-topology-engine** | Node.js 20 (512MB, 120s) | Consolidated structural inference, geometry build, and validation in single memory context. Pipeline: ValidateCSS -> RepairCSS -> NormalizeGeometry -> [TUNNEL] DecomposeTunnelShell -> SnapWallEndpoints (tiered 50mm->150mm) -> BuildTopology -> [BUILDING] MergeWalls -> CleanWallAxes -> InferOpenings -> CreateOpeningRelationships -> InferSlabs -> DeriveRoofElevation -> AlignSlabsToWalls -> SnapSlabsToWallBases -> GuaranteeBuildingEnvelope -> ClampDimensions -> BuildPathConnections (MITRE/BUTT/TEE) -> EquipmentMounting -> AnnotateSweepGeometry -> CSSValidation -> SafetyChecks -> ValidateTopology -> RunFullModelValidation -> v2 Adapter -> Write artifacts to S3 |
| **builting-generate** | Python 3.11 container (512MB) | CSS-driven IFC4 generation with confidence-based semantic mapping, caching, inline IFC validation, self-healing PROXY_ONLY regeneration, mesh fallback, IfcSweptDiskSolid for circular ducts/pipes, IfcCircleHollowProfileDef for hollow profiles, v3 BIM semantics, common Psets, IfcRelConnectsPathElements, glTF (.glb) and OBJ export via trimesh |
| **builting-store** | Node.js 20 | Updates DynamoDB with IFC path, elementCounts, outputMode, cssHash, and all validation fields |

### Bedrock Model

`us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0`

### Step Function

- **builting-state-machine**
- Pipeline: router -> read -> extract -> resolve -> topology-engine -> generate -> store

### IAM

- **builting-role** — shared Lambda execution role
   - Inline policies: builting-logs, builting-dynamo, builting-s3, builting-step-function, builting-bedrock
- **builting-state-machine-role** — Step Functions execution role

### ECR

- `008368474482.dkr.ecr.us-gov-east-1.amazonaws.com/builting-json-to-ifc`

### API Gateway

- **builting-api** (ID: `b665o7k8bc`)
- URL: `https://b665o7k8bc.execute-api.us-gov-east-1.amazonaws.com/prod`
- Stages: `dev`, `prod`
- Structure:
```
/
   /api
      /auth
         OPTIONS
         POST
      /renders
         GET
         OPTIONS
         POST
         /{id}
            DELETE
            GET
            OPTIONS
            /download
               GET (?format=ifc|glb|obj)
               OPTIONS
            /report
               GET
               OPTIONS
            /finalize
               POST
               OPTIONS
      /uploads
         /presigned
            OPTIONS
            POST
      /users
         OPTIONS
         /{id}
            GET
            OPTIONS
```

### CloudWatch Log Groups

- /aws/lambda/builting-router
- /aws/lambda/builting-read
- /aws/lambda/builting-extract
- /aws/lambda/builting-resolve
- /aws/lambda/builting-topology-engine
- /aws/lambda/builting-generate
- /aws/lambda/builting-store

### S3 Buckets

- **builting-data** — raw data user uploads for each render
- **builting-ifc** — generated IFC files for each render

---

