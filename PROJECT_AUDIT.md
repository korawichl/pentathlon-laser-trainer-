# PROJECT AUDIT: Modern Pentathlon Laser Run Training System

## 1. Stack & Architecture Current State
- **Framework:** Vite + TypeScript (Vanilla DOM + HTML5 Canvas)
- **Deployment:** Mobile Web App via HTTPS (BasicSSL plugin for DeviceOrientation on iOS/Android)
- **Sensor layer:** Web `DeviceOrientationEvent` (beta/gamma) + `DeviceMotionEvent` (acceleration)
- **Styling:** CSS variables, dark glassmorphism (some arcade elements present)
- **Data storage:** In-memory array (`shots: ShotRecord[]`), cleared on restart. No IndexedDB/localStorage persistence, no export.

## 2. Gap Analysis: Arcade Elements vs. Elite Sports Science System

| Area | Current Implementation | Elite System Requirement (Master Prompt) | Required Transformation |
|---|---|---|---|
| **Pillars & Tone** | "Game", arcade medals, stars, artificial arcade sounds | Elite Sports Science Lab, dark charcoal `#0f1117`, muted lime `#a3e635`, neutral data-driven UI | Strip all arcade terminology, redesign UI to sports science dashboard |
| **Workflow** | Single 50s shooting round | Multi-round Run-to-Shoot Protocol (e.g. 4 rounds × 600m run + 5 hits / 50s range) | Implement full state machine: Assessment → Run Phase → Transition Phase → Shooting Phase → Series Summary → Multi-round completion |
| **Timer Metrics** | Single `timeLeft` (50s) | Separate: Run Time, Transition Time, First-Shot Time, Split Times, Series Range Time, Total Station Time | Implement high-precision micro-timestamps (`performance.now()`) for each phase |
| **Physiology & HR** | Simulated fake decrement (`158 -> 115`) without labeling | Web Bluetooth BLE Heart Rate (standard HR Profile `0x180D`), manual entry, or labeled synthetic model | Implement Web Bluetooth HRM service + explicit telemetry badge: `[LIVE BLE]`, `[MANUAL]`, or `[SIMULATED]` |
| **Target & Ballistics** | Hardcoded visual circle, fixed 35px/deg | Calibrated target geometry (UIPM 59.5mm hit zone at 10m = 0.1705° angular radius), coordinate origin at target center (mm) | True mm coordinate space with configurable target distance (10m) and diameter |
| **Sensor & Jerk** | Naive delta accel > 4.5 | Pre/post-trigger time window RMS & jerk ratio, jerk direction analysis (down = push/flinch, lateral = trigger slap) | Windowed buffer analysis before/after trigger event |
| **Analytics & Grouping** | Accuracy % and total jerks | Mean Point of Impact (MPI x,y), Mean Radial Error (MRE), Extreme Spread (ES), Horizontal/Vertical dispersion, Cadence splits | Full mathematical biomechanics metrics module |
| **Data Integrity & Export** | None (in-memory only) | Persistent storage (LocalStorage / IndexedDB) + Full CSV/JSON Export of shot-by-shot telemetry for coaches | Export service for CSV containing all timestamps, mm offsets, HR, jerk values |
| **Coaching Engine** | Hardcoded generic text strings | Evidence-based rule engine referencing measured metrics (MPI drift, cadence degradation, fatigue sensitivity) | Deterministic rule-based performance diagnostics engine |

## 3. Implementation Plan
- **Module 1:** Types & Domain Models (`src/types.ts`)
- **Module 2:** Biometrics & BLE Heart Rate Monitor (`src/telemetry/heartRate.ts`)
- **Module 3:** Ballistics & Target Geometry (`src/ballistics/target.ts`)
- **Module 4:** Sensor Biomechanics & Jerk Detection (`src/sensors/motion.ts`)
- **Module 5:** Protocol & State Machine Engine (`src/engine/sessionEngine.ts`)
- **Module 6:** Performance Analytics & Grouping (`src/analytics/stats.ts`)
- **Module 7:** Rule-Based Coaching Diagnostics (`src/analytics/coach.ts`)
- **Module 8:** Data Persistence & CSV Export (`src/storage/export.ts`)
- **Module 9:** High-Performance Sports UI & Canvas Renderer (`src/ui/`, `src/style.css`, `index.html`)
