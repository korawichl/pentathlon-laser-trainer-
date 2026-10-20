/**
 * Elite Modern Pentathlon Laser Pistol & SCATT Biomechanical Training System
 * Domain Models & Telemetry Interfaces
 */

export type DataSourceType = 'HARDWARE_BLE' | 'MANUAL_ENTRY' | 'SIMULATED_MODEL';

export type DrillMode =
  | 'UIPM_5HIT_SERIES'      // Official 5 Hits in 50s (with Table-Touch Start)
  | 'FIRST_SHOT_DRILL'      // 5x Table-Raise to 1st Shot Acquisition Drill
  | 'SCATT_10SHOT_DIAG'     // 10-Shot Precision & Trace Biomechanics Analysis
  | 'CADENCE_METRONOME';    // Paced Rhythm Shooting (e.g. 2.2s per shot)

export type TriggerMechanicsMode =
  | 'TWO_STAGE_RELEASE'     // Stage 1: Hold to take up slack & settle; Stage 2: Crisp release/squeeze
  | 'HOLD_SQUEEZE_LOCK'     // Must maintain aim in target zone for N seconds to unlock sear
  | 'DIRECT_COMPETITION';   // Instant mechanical break ( realistic 30ms lock time + follow-through )

export type SightZeroMode =
  | 'CENTER_HOLD'           // Point of Aim = Center of black (10-ring)
  | 'SUB_SIX_HOLD';         // Point of Aim = Bottom edge of 59.5mm black circle (6 o'clock)

export type TracePhase = 'APPROACH_GREEN' | 'CRITICAL_YELLOW' | 'FOLLOW_BLUE';

export interface TracePoint {
  tRelMs: number;           // Time relative to shot break (e.g. -1000ms to +250ms)
  xMm: number;              // Horizontal target coordinate (mm from center)
  yMm: number;              // Vertical target coordinate (mm from center)
  cantDeg: number;          // Pistol roll/tilt angle in degrees
  frontSightShiftMm: number;// Wrist alignment error inside rear sight notch (mm)
}

export interface ScattShotMetrics {
  decimalScore: number;         // 0.0 to 10.9 (ISSF / UIPM decimal scoring, >= 7.0 is HIT)
  clockDirection: number;       // 1 to 12 o'clock
  traceLengthMmPerSec: number;  // Speed of muzzle trace in last 1.0s (mm/s) - SCATT "L" metric
  stability7RingPct: number;    // % of last 1.0s spent inside 59.5mm Hit Zone (7.0 ring)
  stability10RingPct: number;   // % of last 1.0s spent inside 11.5mm 10-ring
  pullErrorMm: number;          // Distance between mean hold (-300ms..-80ms) and actual impact (mm)
  pullDirectionClock: number;   // Direction of trigger pull error (1-12 o'clock)
  followThroughDriftMm: number; // Muzzle displacement during +150ms after shot
  cantAngleAtShotDeg: number;   // Pistol roll angle at trigger break
  holdDurationSec: number;      // Time spent aiming since raising from table or previous shot
}

export interface JerkAnalysis {
  isJerk: boolean;
  preTriggerStabilityRms: number;
  triggerSpikePeak: number;
  jerkRatio: number;
  flinchDirection: 'NONE' | 'LOW_DOWN' | 'LOW_LEFT' | 'LOW_RIGHT' | 'LATERAL_RIGHT' | 'LATERAL_LEFT' | 'HIGH_UP' | 'POOR_FOLLOW_THROUGH';
}

export interface ShotRecord {
  shotIndex: number;
  roundIndex: number;
  timestampIso: string;
  timeSinceSeriesStartSec: number;
  splitFromPrevShotSec: number;
  offsetMmX: number;
  offsetMmY: number;
  radialErrorMm: number;
  isHit: boolean;
  currentBpm: number;
  bpmSource: DataSourceType;
  breathHeldAtShot: boolean;
  deltoidFatiguePct: number;
  jerk: JerkAnalysis;
  scatt: ScattShotMetrics;
  trace: TracePoint[];          // Full -1000ms to +250ms trajectory for SCATT replay
}

export interface SeriesResult {
  seriesId: string;
  dateIso: string;
  drillMode: DrillMode;
  roundIndex: number;
  runDurationSec: number;
  transitionDurationSec: number;
  firstShotDurationSec: number;
  pureShootingDurationSec: number;
  totalRangeStationDurationSec: number;
  totalShotsFired: number;
  hitsCleared: number;
  isTimedOut: boolean;
  accuracyPct: number;
  avgDecimalScore: number;
  avgTraceLengthMmPerSec: number;
  avgStability7RingPct: number;
  avgPullErrorMm: number;
  meanPointOfImpactMm: { x: number; y: number };
  meanRadialErrorMm: number;
  horizontalDispersionMm: number;
  verticalDispersionMm: number;
  extremeSpreadMm: number;
  shots: ShotRecord[];
  heartRateEnterBpm: number;
  heartRateExitBpm: number;
  hrSource: DataSourceType;
  coachDiagnostics: string[];
}

export interface PreSessionData {
  athleteId: string;
  athleteName: string;
  dateIso: string;
  sessionType: 'COMPETITION_SIM' | 'INTERVAL_ENDURANCE' | 'TECHNICAL_DRILL';
  restingBpm: number;
  restingBpmSource: DataSourceType;
  surface: 'TRACK' | 'GRASS' | 'ROAD' | 'INDOOR_TREADMILL';
  environmentalTempC: number;
  rpePre: number;
}

export interface TrainingProtocol {
  id: string;
  name: string;
  totalRounds: number;
  runDistanceMetersPerRound: number;
  requiredHitsPerSeries: number;
  maxSeriesDurationSec: number;
  targetDistanceMeters: number;
  targetDiameterMm: number;
  allowVirtualSwayInSimulation: boolean;
}

export interface MotionSample {
  timestampMs: number;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  accelX: number;
  accelY: number;
  accelZ: number;
  xMm?: number;
  yMm?: number;
  frontSightShiftMm?: number;
}

export interface CompleteSessionData {
  sessionId: string;
  protocol: TrainingProtocol;
  preAssessment: PreSessionData;
  rpePost: number;
  series: SeriesResult[];
  totalSessionDurationSec: number;
  overallAccuracyPct: number;
  averageRangeStationTimeSec: number;
  coachFeedback: string[];
}
