import {
  DataSourceType,
  DrillMode,
  MotionSample,
  SeriesResult,
  ShotRecord,
  SightZeroMode,
  TracePoint,
  TriggerMechanicsMode
} from './types';
import { TargetGeometry } from './ballistics/target';
import { MotionBiomechanics, OneEuroFilter } from './sensors/motion';
import { HeartRateTelemetry } from './telemetry/heartRate';
import { PerformanceAnalytics } from './analytics/stats';
import { SessionStorageExport } from './storage/export';
import { sfx } from './sound';

class ScattUipmRangeController {
  // Configuration State
  private drillMode: DrillMode = 'UIPM_5HIT_SERIES';
  private triggerMode: TriggerMechanicsMode = 'TWO_STAGE_RELEASE';
  private sightZeroMode: SightZeroMode = 'CENTER_HOLD';
  private requiredHoldSec = 0.9;
  private sensitivityMult = 1.25;
  private showLiveTrace = true;

  // Services
  private targetGeo = new TargetGeometry(10.0, 59.5);
  private biomech = new MotionBiomechanics();
  private bleHr = new HeartRateTelemetry();
  private yawFilter = new OneEuroFilter(4.5, 0.04, 1.0);
  private pitchFilter = new OneEuroFilter(4.5, 0.04, 1.0);
  private rollFilter = new OneEuroFilter(3.5, 0.03, 1.0);

  // Biometric Telemetry
  private entryBpm = 174;
  private currentBpm = 174;
  private hrSource: DataSourceType = 'SIMULATED_MODEL';
  private isHoldingBreath = false;
  private lastSystolicPeak = false;
  private currentO2Stress01 = 0;
  private currentDeltoidPct = 0;

  // Sensor & Aim State
  private hasGyro = false;
  private rawGamma = 0;
  private rawBeta = 75;
  private rawAlpha = 0;
  private zeroGamma = 0;
  private zeroBeta = 75;
  private latestAccel = { x: 0, y: 0, z: 0 };

  // Desktop fallback state
  private pointerYawDeg = 0;
  private pointerPitchDeg = 0;
  private pointerRollDeg = 0;

  // Computed live coordinates on 10m target (mm)
  private currentXMm = 0;
  private currentYMm = 0;
  private currentRadialMm = 0;
  private currentCantDeg = 0;
  private currentFrontSightShiftMm = 0;
  private liveTraceSpeedMmPerSec = 0;
  private recentAimTrail: { tMs: number; xMm: number; yMm: number }[] = [];

  // Station & Drill Lifecycle State
  private isStationActive = false;
  private isTableArmed = false;       // Must touch table before first shot (or before each shot in FIRST_SHOT_DRILL)
  private stationStartPerfMs = 0;     // Set when pistol lifts from table (or touches table to arm)
  private lastRaiseFromTableMs = 0;
  private lastShotPerfMs = 0;
  private maxDurationSec = 50.0;
  private requiredHits = 5;
  private maxShotsInDrill = 99;

  // Trigger Mechanics State
  private isStage1Held = false;
  private stage1StartMs = 0;
  private currentHoldInZoneSec = 0;
  private pendingFollowThroughShot: {
    shotIndex: number;
    shotPerfMs: number;
    timeSinceStartSec: number;
    splitSec: number;
    xMm: number;
    yMm: number;
    radialMm: number;
    isHit: boolean;
    cantDeg: number;
    holdSec: number;
    bpm: number;
    breathHeld: boolean;
    deltoidPct: number;
  } | null = null;

  // Cadence Metronome
  private cadenceIntervalSec = 2.1;
  private nextMetronomeTickSec = 2.1;

  // Recorded Shots & Result Replay
  private currentShots: ShotRecord[] = [];
  private hitsCount = 0;
  private lastSeriesResult: SeriesResult | null = null;
  private selectedReplayShotIdx: number = -1; // -1 = All shots overview

  // Animation loop
  private animFrameId = 0;
  private lastFrameMs = 0;

  // Canvas references
  private rangeCanvas!: HTMLCanvasElement;
  private rangeCtx!: CanvasRenderingContext2D;
  private replayCanvas!: HTMLCanvasElement;
  private replayCtx!: CanvasRenderingContext2D;

  constructor() {
    this.rangeCanvas = document.getElementById('range-canvas') as HTMLCanvasElement;
    this.rangeCtx = this.rangeCanvas.getContext('2d')!;
    this.replayCanvas = document.getElementById('scatt-replay-canvas') as HTMLCanvasElement;
    this.replayCtx = this.replayCanvas.getContext('2d')!;

    this.bindSetupControls();
    this.bindRangeControls();
    this.bindResultControls();
    this.initMotionListeners();
    this.resizeRangeCanvas();
    window.addEventListener('resize', () => this.resizeRangeCanvas());
  }

  private switchScreen(screenId: 'view-setup' | 'view-range' | 'view-result') {
    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
    document.getElementById(screenId)?.classList.add('active');
    if (screenId === 'view-range') {
      this.resizeRangeCanvas();
    }
  }

  private bindSetupControls() {
    const hrSelect = document.getElementById('select-hr-profile') as HTMLSelectElement;
    hrSelect?.addEventListener('change', () => {
      if (this.hrSource !== 'HARDWARE_BLE') {
        this.entryBpm = parseInt(hrSelect.value, 10) || 174;
        this.currentBpm = this.entryBpm;
        this.updateSetupBadges();
      }
    });

    document.getElementById('btn-connect-ble-hr')?.addEventListener('click', async () => {
      this.bleHr.subscribe((bpm, source) => {
        if (source === 'HARDWARE_BLE') {
          this.currentBpm = bpm;
          this.entryBpm = bpm;
          this.hrSource = 'HARDWARE_BLE';
          this.updateSetupBadges();
        }
      });
      const ok = await this.bleHr.connectBleSensor();
      if (!ok) {
        alert('ไม่พบสายคาดอก Bluetooth Heart Rate — ระบบใช้โมเดลจำลองคลื่นชีพจรตามความเหนื่อยแทน');
      }
    });

    const audioBtn = document.getElementById('btn-Audio-Toggle');
    audioBtn?.addEventListener('click', () => {
      sfx.muted = !sfx.muted;
      audioBtn.textContent = !sfx.muted ? '🔊 เสียงสนาม & ชีพจร: ON' : '🔇 เสียงสนาม & ชีพจร: OFF';
    });

    document.getElementById('btn-enter-range')?.addEventListener('click', async () => {
      await this.requestIosOrientationPermission();
      this.readSetupConfiguration();
      this.startRangeSession();
    });
  }

  private updateSetupBadges() {
    const badge = document.getElementById('setup-hr-badge');
    if (!badge) return;
    if (this.hrSource === 'HARDWARE_BLE') {
      badge.className = 'badge badge-hardware';
      badge.textContent = `HR: ${this.currentBpm} BPM [BLE LIVE]`;
    } else {
      badge.className = 'badge badge-simulated';
      badge.textContent = `HR: ${this.entryBpm} BPM [BIOMECH SIM]`;
    }
  }

  private readSetupConfiguration() {
    this.drillMode = ((document.getElementById('select-drill-mode') as HTMLSelectElement)?.value ||
      'UIPM_5HIT_SERIES') as DrillMode;
    this.triggerMode = ((document.getElementById('select-trigger-mode') as HTMLSelectElement)?.value ||
      'TWO_STAGE_RELEASE') as TriggerMechanicsMode;
    this.sightZeroMode = ((document.getElementById('select-sight-mode') as HTMLSelectElement)?.value ||
      'CENTER_HOLD') as SightZeroMode;
    this.requiredHoldSec = parseFloat(
      (document.getElementById('select-hold-time') as HTMLSelectElement)?.value || '0.9'
    );
    this.sensitivityMult = parseFloat(
      (document.getElementById('select-sensitivity') as HTMLSelectElement)?.value || '1.25'
    );
    const traceVal = (document.getElementById('select-live-trace') as HTMLSelectElement)?.value;
    this.showLiveTrace = traceVal !== 'BLIND_COMPETITION';

    if (this.hrSource !== 'HARDWARE_BLE') {
      this.entryBpm = parseInt(
        (document.getElementById('select-hr-profile') as HTMLSelectElement)?.value || '174',
        10
      );
      this.currentBpm = this.entryBpm;
    }

    // Configure Drill Rules
    if (this.drillMode === 'UIPM_5HIT_SERIES') {
      this.requiredHits = 5;
      this.maxShotsInDrill = 25;
      this.maxDurationSec = 50.0;
    } else if (this.drillMode === 'FIRST_SHOT_DRILL') {
      this.requiredHits = 5;
      this.maxShotsInDrill = 5;
      this.maxDurationSec = 60.0;
    } else if (this.drillMode === 'SCATT_10SHOT_DIAG') {
      this.requiredHits = 10;
      this.maxShotsInDrill = 10;
      this.maxDurationSec = 120.0;
    } else if (this.drillMode === 'CADENCE_METRONOME') {
      this.requiredHits = 5;
      this.maxShotsInDrill = 15;
      this.maxDurationSec = 45.0;
    }
  }

  private bindRangeControls() {
    // Table Touch / Zero Button
    const tableBtn = document.getElementById('btn-table-touch');
    tableBtn?.addEventListener('click', () => this.performTableTouchAndZero());

    // Breath Hold Button (Touch & Mouse)
    const breathBtn = document.getElementById('btn-breath-hold');
    const startBreath = (e: Event) => {
      e.preventDefault();
      this.isHoldingBreath = true;
      breathBtn?.classList.add('holding');
    };
    const endBreath = (e: Event) => {
      e.preventDefault();
      this.isHoldingBreath = false;
      breathBtn?.classList.remove('holding');
    };
    breathBtn?.addEventListener('pointerdown', startBreath);
    breathBtn?.addEventListener('pointerup', endBreath);
    breathBtn?.addEventListener('pointerleave', endBreath);
    breathBtn?.addEventListener('pointercancel', endBreath);

    // Trigger Button (Supports both 2-Stage Press-Hold-Release and Direct Press)
    const fireBtn = document.getElementById('btn-fire');
    fireBtn?.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.onTriggerPressStart();
    });
    fireBtn?.addEventListener('pointerup', (e) => {
      e.preventDefault();
      this.onTriggerRelease();
    });

    // Desktop Mouse Aiming on Range Canvas
    this.rangeCanvas.addEventListener('pointermove', (e) => {
      const rect = this.rangeCanvas.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width - 0.5) * 2.0; // -1 to +1
      const ny = (0.5 - (e.clientY - rect.top) / rect.height) * 2.0; // -1 to +1
      this.pointerYawDeg = nx * 0.65;
      this.pointerPitchDeg = ny * 0.65;
    });

    // Wheel tilts pistol cant angle slightly on desktop for testing Cant physics
    this.rangeCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.pointerRollDeg = Math.max(-12, Math.min(12, this.pointerRollDeg + (e.deltaY > 0 ? 0.6 : -0.6)));
    }, { passive: false });

    // Hardware Volume / Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (!this.isStationActive) return;
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        this.onTriggerPressStart();
      } else if (e.key === 'Shift' && !e.repeat) {
        this.isHoldingBreath = true;
        document.getElementById('btn-breath-hold')?.classList.add('holding');
      } else if (e.code === 'KeyR') {
        this.performTableTouchAndZero();
      } else if (e.code === 'KeyQ') {
        this.pointerRollDeg = Math.max(-12, this.pointerRollDeg - 1.0);
      } else if (e.code === 'KeyE') {
        this.pointerRollDeg = Math.min(12, this.pointerRollDeg + 1.0);
      } else if (e.key === 'AudioVolumeUp' || e.key === 'AudioVolumeDown') {
        e.preventDefault();
        this.onTriggerPressStart();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (!this.isStationActive) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.onTriggerRelease();
      } else if (e.key === 'Shift') {
        this.isHoldingBreath = false;
        document.getElementById('btn-breath-hold')?.classList.remove('holding');
      } else if (e.key === 'AudioVolumeUp' || e.key === 'AudioVolumeDown') {
        e.preventDefault();
        this.onTriggerRelease();
      }
    });
  }

  private bindResultControls() {
    document.getElementById('btn-retry-range')?.addEventListener('click', () => {
      this.startRangeSession();
    });

    document.getElementById('btn-back-setup')?.addEventListener('click', () => {
      this.switchScreen('view-setup');
    });

    document.getElementById('btn-export-series-csv')?.addEventListener('click', () => {
      if (this.lastSeriesResult) {
        SessionStorageExport.exportSeriesToCsv(this.lastSeriesResult);
      }
    });
  }

  private async requestIosOrientationPermission() {
    const devOrient = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (typeof devOrient.requestPermission === 'function') {
      try {
        await devOrient.requestPermission();
      } catch {
        // Ignore if denied or desktop
      }
    }
  }

  private initMotionListeners() {
    window.addEventListener('deviceorientation', (e) => {
      if (e.gamma !== null && e.beta !== null) {
        this.hasGyro = true;
        this.rawGamma = e.gamma;
        this.rawBeta = e.beta;
        this.rawAlpha = e.alpha || 0;

        // Auto table-touch detection if phone is tilted down steeply (<= -16 deg relative to zero)
        if (this.isStationActive && !this.isTableArmed) {
          const relPitch = this.rawBeta - this.zeroBeta;
          if (relPitch <= -16) {
            this.performTableTouchAndZero();
          }
        }
      }
    });

    window.addEventListener('devicemotion', (e) => {
      const acc = e.acceleration || e.accelerationIncludingGravity;
      if (acc) {
        this.latestAccel = {
          x: acc.x || 0,
          y: acc.y || 0,
          z: acc.z || 0
        };
      }
    });
  }

  private resizeRangeCanvas() {
    if (!this.rangeCanvas) return;
    const rect = this.rangeCanvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.rangeCanvas.width = rect.width * window.devicePixelRatio;
      this.rangeCanvas.height = rect.height * window.devicePixelRatio;
      this.rangeCtx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    }
  }

  // ===========================================================================
  // STATION LIFECYCLE & TABLE-TOUCH START PROTOCOL
  // ===========================================================================

  private startRangeSession() {
    this.switchScreen('view-range');
    this.isStationActive = true;
    this.isTableArmed = false;
    this.currentShots = [];
    this.hitsCount = 0;
    this.recentAimTrail = [];
    this.pendingFollowThroughShot = null;
    this.isStage1Held = false;
    this.currentHoldInZoneSec = 0;
    this.pointerRollDeg = 0;
    this.biomech.deltoidHoldSec = 0;
    this.biomech.currentBreathHoldSec = 0;

    // Reset lamps
    for (let i = 1; i <= 5; i++) {
      const lamp = document.getElementById(`lamp-dot-${i}`);
      if (lamp) lamp.className = 'lamp-dot';
    }

    const banner = document.getElementById('table-touch-banner');
    if (banner) {
      banner.classList.add('visible');
      banner.innerHTML =
        '⬇️ <strong>TABLE START REQUIRED:</strong> ลดปืนแตะโต๊ะ (ก้มมือถือลง) หรือกดปุ่ม <strong>[⬇️ แตะโต๊ะ / Zero (R)]</strong> เพื่อเริ่มยกปืนยิงนัดแรก';
    }

    const readout = document.getElementById('hud-last-shot-readout');
    if (readout) {
      readout.textContent = 'TOUCH TABLE TO ARM';
      readout.style.color = '#fbbf24';
    }

    this.updateTriggerButtonVisual();
    this.lastFrameMs = performance.now();
    cancelAnimationFrame(this.animFrameId);
    this.animFrameId = requestAnimationFrame((t) => this.loopRange(t));
  }

  private performTableTouchAndZero() {
    if (!this.isStationActive) return;

    this.zeroGamma = this.rawGamma;
    this.zeroBeta = this.rawBeta;
    this.pointerYawDeg = 0;
    this.pointerPitchDeg = 0;
    this.pointerRollDeg = 0;
    this.yawFilter.reset();
    this.pitchFilter.reset();
    this.rollFilter.reset();
    this.biomech.resetDeltoidFatigue();

    const now = performance.now();
    if (this.currentShots.length === 0 && !this.isTableArmed) {
      this.stationStartPerfMs = now;
      this.nextMetronomeTickSec = this.cadenceIntervalSec;
    }
    this.lastRaiseFromTableMs = now;
    this.isTableArmed = true;

    sfx.playTakeUp();
    const banner = document.getElementById('table-touch-banner');
    if (banner) banner.classList.remove('visible');

    const readout = document.getElementById('hud-last-shot-readout');
    if (readout) {
      readout.textContent = 'ARMED — ACQUIRE TARGET';
      readout.style.color = '#38bdf8';
    }
  }

  // ===========================================================================
  // REALISTIC TRIGGER MECHANICS (STAGE 1 SEAR WALL + STAGE 2 BREAK)
  // ===========================================================================

  private onTriggerPressStart() {
    if (!this.isStationActive || this.pendingFollowThroughShot) return;

    if (!this.isTableArmed) {
      // Remind athlete to touch table first
      sfx.playJerk();
      const banner = document.getElementById('table-touch-banner');
      if (banner) banner.classList.add('visible');
      return;
    }

    if (this.triggerMode === 'TWO_STAGE_RELEASE') {
      // Stage 1: Take up slack to the sear wall
      this.isStage1Held = true;
      this.stage1StartMs = performance.now();
      sfx.playTakeUp();
      this.updateTriggerButtonVisual();
    } else if (this.triggerMode === 'HOLD_SQUEEZE_LOCK') {
      if (this.currentHoldInZoneSec >= this.requiredHoldSec) {
        this.initiateShotBreak();
      } else {
        sfx.playJerk();
      }
    } else {
      // DIRECT_COMPETITION
      this.initiateShotBreak();
    }
  }

  private onTriggerRelease() {
    if (!this.isStationActive) return;
    if (this.triggerMode === 'TWO_STAGE_RELEASE' && this.isStage1Held) {
      this.isStage1Held = false;
      this.updateTriggerButtonVisual();
      if (!this.pendingFollowThroughShot && this.isTableArmed) {
        this.initiateShotBreak();
      }
    }
  }

  private initiateShotBreak() {
    const nowPerf = performance.now();
    const timeSinceStartSec = (nowPerf - this.stationStartPerfMs) / 1000.0;
    const splitSec =
      this.currentShots.length === 0
        ? timeSinceStartSec
        : (nowPerf - this.lastShotPerfMs) / 1000.0;
    const holdSec = (nowPerf - this.lastRaiseFromTableMs) / 1000.0;

    this.lastShotPerfMs = nowPerf;
    sfx.playShot();
    if (navigator.vibrate) navigator.vibrate(25);

    const isHit = this.targetGeo.evaluateHit(this.currentRadialMm, 1.0);

    // Queue 160ms post-shot follow-through capture so SCATT trace records blue follow-through
    this.pendingFollowThroughShot = {
      shotIndex: this.currentShots.length + 1,
      shotPerfMs: nowPerf,
      timeSinceStartSec: parseFloat(timeSinceStartSec.toFixed(2)),
      splitSec: parseFloat(splitSec.toFixed(2)),
      xMm: parseFloat(this.currentXMm.toFixed(2)),
      yMm: parseFloat(this.currentYMm.toFixed(2)),
      radialMm: parseFloat(this.currentRadialMm.toFixed(2)),
      isHit,
      cantDeg: this.currentCantDeg,
      holdSec,
      bpm: this.currentBpm,
      breathHeld: this.isHoldingBreath,
      deltoidPct: this.currentDeltoidPct
    };
  }

  private finalizePendingShot() {
    const p = this.pendingFollowThroughShot;
    if (!p) return;
    this.pendingFollowThroughShot = null;

    const jerk = this.biomech.analyzeTriggerJerk(p.shotPerfMs);
    const { scatt, trace } = this.biomech.computeScattMetricsAndTrace(
      p.shotPerfMs,
      p.xMm,
      p.yMm,
      p.cantDeg,
      p.holdSec,
      this.targetGeo
    );

    // If athlete jerked severely on trigger release, penalize radial error slightly if not already reflected
    const shotRecord: ShotRecord = {
      shotIndex: p.shotIndex,
      roundIndex: 1,
      timestampIso: new Date().toISOString(),
      timeSinceSeriesStartSec: p.timeSinceStartSec,
      splitFromPrevShotSec: p.splitSec,
      offsetMmX: p.xMm,
      offsetMmY: p.yMm,
      radialErrorMm: p.radialMm,
      isHit: p.isHit,
      currentBpm: p.bpm,
      bpmSource: this.hrSource,
      breathHeldAtShot: p.breathHeld,
      deltoidFatiguePct: p.deltoidPct,
      jerk,
      scatt,
      trace
    };

    this.currentShots.push(shotRecord);

    // Show Jerk Alert if detected
    const jerkAlert = document.getElementById('range-jerk-alert');
    if (jerk.isJerk && jerkAlert) {
      jerkAlert.textContent = `⚠️ TRIGGER FLINCH (${jerk.flinchDirection}) — Pull Error ${scatt.pullErrorMm}mm @ ${scatt.pullDirectionClock}h`;
      jerkAlert.classList.add('visible');
      sfx.playJerk();
      setTimeout(() => jerkAlert.classList.remove('visible'), 1600);
    }

    // Update Ecoaims LED Lamps & Digital Score Readout
    const readout = document.getElementById('hud-last-shot-readout');
    if (p.isHit) {
      this.hitsCount++;
      sfx.playHit();
      const lampIdx = ((this.hitsCount - 1) % 5) + 1;
      const lamp = document.getElementById(`lamp-dot-${lampIdx}`);
      if (lamp) lamp.className = 'lamp-dot hit';
      if (readout) {
        readout.textContent = `HIT ${scatt.decimalScore.toFixed(1)} (${scatt.clockDirection}h) • ${p.splitSec.toFixed(2)}s`;
        readout.style.color = '#22c55e';
      }
    } else {
      const lampIdx = (this.hitsCount % 5) + 1;
      const lamp = document.getElementById(`lamp-dot-${lampIdx}`);
      if (lamp) {
        lamp.className = 'lamp-dot miss-flash';
        setTimeout(() => {
          if (lamp.classList.contains('miss-flash')) lamp.className = 'lamp-dot';
        }, 550);
      }
      if (readout) {
        readout.textContent = `MISS ${scatt.decimalScore.toFixed(1)} (${scatt.clockDirection}h) • Pull ${scatt.pullErrorMm}mm`;
        readout.style.color = '#ef4444';
      }
    }

    // In FIRST_SHOT_DRILL, require touching the table again before the next shot!
    if (this.drillMode === 'FIRST_SHOT_DRILL' && this.currentShots.length < this.maxShotsInDrill) {
      this.isTableArmed = false;
      const banner = document.getElementById('table-touch-banner');
      if (banner) {
        banner.classList.add('visible');
        banner.innerHTML = `⬇️ <strong>FIRST-SHOT DRILL (${this.currentShots.length}/5):</strong> ลดปืนแตะโต๊ะอีกครั้ง (กด R หรือก้มมือถือ) เพื่อฝึกยกปืนนัดต่อไป`;
      }
    } else {
      this.lastRaiseFromTableMs = performance.now();
    }

    // Check Series Completion Conditions
    if (
      (this.drillMode === 'UIPM_5HIT_SERIES' && this.hitsCount >= this.requiredHits) ||
      (this.drillMode === 'CADENCE_METRONOME' && this.hitsCount >= this.requiredHits) ||
      this.currentShots.length >= this.maxShotsInDrill
    ) {
      sfx.playSeriesCleared();
      this.completeSeries(false);
    }
  }

  // ===========================================================================
  // MAIN 60FPS TELEMETRY & RENDERING LOOP
  // ===========================================================================

  private loopRange(nowMs: number) {
    if (!this.isStationActive) return;

    const dtSec = Math.min(0.1, Math.max(0.001, (nowMs - this.lastFrameMs) / 1000.0));
    this.lastFrameMs = nowMs;

    // 1. Update Station Timer (once table is armed)
    let elapsedSec = 0;
    if (this.stationStartPerfMs > 0) {
      elapsedSec = (nowMs - this.stationStartPerfMs) / 1000.0;
    }
    const remainingSec = Math.max(0, this.maxDurationSec - elapsedSec);
    const timerEl = document.getElementById('range-countdown-val');
    if (timerEl) {
      timerEl.textContent = remainingSec.toFixed(1);
      timerEl.style.color = remainingSec <= 10.0 ? '#ef4444' : '#f8fafc';
    }

    if (this.isTableArmed && remainingSec <= 0) {
      this.completeSeries(true);
      return;
    }

    // Cadence Metronome Beep
    if (this.drillMode === 'CADENCE_METRONOME' && this.isTableArmed && elapsedSec >= this.nextMetronomeTickSec) {
      sfx.playMetronomeTick();
      this.nextMetronomeTickSec += this.cadenceIntervalSec;
    }

    // 2. Gradual HR Recovery during station (-0.35 BPM/sec unless breath held)
    if (this.hrSource !== 'HARDWARE_BLE') {
      const hrDelta = this.isHoldingBreath ? 0.15 : -0.32;
      this.currentBpm = Math.max(62, Math.min(198, this.currentBpm + hrDelta * dtSec));
    }

    // 3. Step Physiological Sway, Systolic Pulse, Hypoxia & Deltoid Fatigue
    const phys = this.biomech.stepPhysiology(
      dtSec,
      this.currentBpm,
      this.isHoldingBreath,
      this.isTableArmed
    );
    this.currentO2Stress01 = phys.hypoxicStress01;
    this.currentDeltoidPct = phys.deltoidFatiguePct;

    if (phys.isSystolicPeak && !this.lastSystolicPeak) {
      const pulseDot = document.getElementById('hud-pulse-dot');
      pulseDot?.classList.add('beat');
      if (this.currentBpm >= 135) {
        sfx.playHeartbeat(Math.min(1, (this.currentBpm - 100) / 90));
      }
      setTimeout(() => pulseDot?.classList.remove('beat'), 110);
    }
    this.lastSystolicPeak = phys.isSystolicPeak;

    // 4. Fuse Hardware Gyroscope / Pointer + 1-Euro Filter + Physiology
    let baseYawDeg = this.pointerYawDeg;
    let basePitchDeg = this.pointerPitchDeg;
    let baseRollDeg = this.pointerRollDeg;

    if (this.hasGyro) {
      baseYawDeg = (this.rawGamma - this.zeroGamma) * 0.26 * this.sensitivityMult;
      basePitchDeg = (this.rawBeta - this.zeroBeta) * 0.26 * this.sensitivityMult;
      baseRollDeg = (this.rawGamma - this.zeroGamma) * 0.35;
    } else {
      baseYawDeg *= this.sensitivityMult;
      basePitchDeg *= this.sensitivityMult;
    }

    // Stage 1 sear engagement steadies wrist slightly (15% damping)
    const stage1Damp = this.isStage1Held ? 0.84 : 1.0;

    const totalYawDeg = this.yawFilter.filter(baseYawDeg + phys.swayYawDeg * stage1Damp, dtSec);
    const totalPitchDeg = this.pitchFilter.filter(basePitchDeg + phys.swayPitchDeg * stage1Damp, dtSec);
    this.currentCantDeg = this.rollFilter.filter(baseRollDeg, dtSec);

    // Front sight micro-shift inside rear notch (driven by pulse + angular velocity)
    this.currentFrontSightShiftMm = phys.frontSightPulseMm * (this.isStage1Held ? 0.75 : 1.15);

    const targetCoords = this.targetGeo.anglesToTargetMm(
      totalYawDeg,
      totalPitchDeg,
      this.currentCantDeg,
      this.currentFrontSightShiftMm
    );
    this.currentXMm = targetCoords.xMm;
    this.currentYMm = targetCoords.yMm;
    this.currentRadialMm = targetCoords.radialErrorMm;

    // Push sample into 2000ms SCATT Biomechanics Buffer
    const sample: MotionSample = {
      timestampMs: nowMs,
      yawDeg: totalYawDeg,
      pitchDeg: totalPitchDeg,
      rollDeg: this.currentCantDeg,
      accelX: this.latestAccel.x,
      accelY: this.latestAccel.y,
      accelZ: this.latestAccel.z,
      xMm: this.currentXMm,
      yMm: this.currentYMm,
      frontSightShiftMm: this.currentFrontSightShiftMm
    };
    this.biomech.pushSample(sample);

    // Maintain 1.0s trail for live SCATT trace & live speed (mm/s)
    this.recentAimTrail.push({ tMs: nowMs, xMm: this.currentXMm, yMm: this.currentYMm });
    while (this.recentAimTrail.length > 0 && nowMs - this.recentAimTrail[0].tMs > 1000) {
      this.recentAimTrail.shift();
    }
    this.computeLiveTraceSpeed();

    // Check if pending follow-through window (+160ms) has completed
    if (this.pendingFollowThroughShot && nowMs - this.pendingFollowThroughShot.shotPerfMs >= 160) {
      this.finalizePendingShot();
      if (!this.isStationActive) return;
    }

    // Update Hold-and-Squeeze Lock Progress
    const inHitZone = this.currentRadialMm <= this.targetGeo.getHitZoneRadiusMm();
    if (this.isTableArmed && inHitZone) {
      this.currentHoldInZoneSec = Math.min(this.requiredHoldSec, this.currentHoldInZoneSec + dtSec);
    } else {
      this.currentHoldInZoneSec = Math.max(0, this.currentHoldInZoneSec - dtSec * 1.6);
    }

    this.updateLiveHudTelemetry();
    this.renderRangeCanvas();

    this.animFrameId = requestAnimationFrame((t) => this.loopRange(t));
  }

  private computeLiveTraceSpeed() {
    if (this.recentAimTrail.length < 4) {
      this.liveTraceSpeedMmPerSec = 0;
      return;
    }
    let dist = 0;
    for (let i = 1; i < this.recentAimTrail.length; i++) {
      dist += Math.hypot(
        this.recentAimTrail[i].xMm - this.recentAimTrail[i - 1].xMm,
        this.recentAimTrail[i].yMm - this.recentAimTrail[i - 1].yMm
      );
    }
    const spanSec =
      (this.recentAimTrail[this.recentAimTrail.length - 1].tMs - this.recentAimTrail[0].tMs) / 1000.0;
    this.liveTraceSpeedMmPerSec = spanSec > 0.05 ? Math.round(dist / spanSec) : 0;
  }

  private updateLiveHudTelemetry() {
    const bpmEl = document.getElementById('hud-bpm-val');
    if (bpmEl) bpmEl.textContent = Math.round(this.currentBpm).toString();

    const speedEl = document.getElementById('hud-trace-speed');
    if (speedEl) {
      speedEl.textContent = this.liveTraceSpeedMmPerSec.toString();
      speedEl.style.color =
        this.liveTraceSpeedMmPerSec <= 95
          ? '#22c55e'
          : this.liveTraceSpeedMmPerSec <= 155
          ? '#eab308'
          : '#ef4444';
    }

    const cantEl = document.getElementById('hud-cant-deg');
    if (cantEl) {
      cantEl.textContent = `${this.currentCantDeg >= 0 ? '+' : ''}${this.currentCantDeg.toFixed(1)}°`;
      cantEl.style.color = Math.abs(this.currentCantDeg) > 2.5 ? '#ef4444' : '#f8fafc';
    }

    const o2Bar = document.getElementById('bar-o2');
    if (o2Bar) {
      const o2RemainingPct = Math.round(Math.max(0, 1.0 - this.currentO2Stress01) * 100);
      o2Bar.style.width = `${o2RemainingPct}%`;
      o2Bar.style.background = this.currentO2Stress01 > 0.35 ? '#ef4444' : '#38bdf8';
    }

    const deltoidBar = document.getElementById('bar-deltoid');
    if (deltoidBar) {
      deltoidBar.style.width = `${this.currentDeltoidPct}%`;
    }

    this.updateTriggerButtonVisual();
  }

  private updateTriggerButtonVisual() {
    const fireBtn = document.getElementById('btn-fire');
    const stabLabel = document.getElementById('stability-label');
    if (!fireBtn || !stabLabel) return;

    if (!this.isTableArmed) {
      fireBtn.className = 'btn btn-trigger-action disabled-lock';
      fireBtn.textContent = '⬇️ TOUCH TABLE FIRST';
      stabLabel.textContent = 'TABLE START REQUIRED';
      stabLabel.style.color = '#fbbf24';
      return;
    }

    if (this.triggerMode === 'TWO_STAGE_RELEASE') {
      if (this.isStage1Held) {
        fireBtn.className = 'btn btn-trigger-action stage1-engaged';
        fireBtn.textContent = '⚡ SEAR ENGAGED — RELEASE TO FIRE';
        stabLabel.textContent = 'STAGE 1 WALL LOCKED — CRISP RELEASE';
        stabLabel.style.color = '#fbbf24';
      } else {
        fireBtn.className = 'btn btn-trigger-action unlocked';
        fireBtn.textContent = '🔥 HOLD STAGE 1 ➔ RELEASE';
        stabLabel.textContent =
          this.currentRadialMm <= 29.75 ? 'IN 7-RING HIT ZONE (59.5mm)' : 'ALIGN SIGHTS TO BLACK ZONE';
        stabLabel.style.color = this.currentRadialMm <= 29.75 ? '#22c55e' : '#94a3b8';
      }
    } else if (this.triggerMode === 'HOLD_SQUEEZE_LOCK') {
      const pct = Math.min(100, Math.round((this.currentHoldInZoneSec / this.requiredHoldSec) * 100));
      if (pct >= 100) {
        fireBtn.className = 'btn btn-trigger-action unlocked';
        fireBtn.textContent = '🔥 SEAR UNLOCKED — FIRE!';
        stabLabel.textContent = `STABILITY LOCKED (100%)`;
        stabLabel.style.color = '#22c55e';
      } else {
        fireBtn.className = 'btn btn-trigger-action disabled-lock';
        fireBtn.textContent = `🔒 HOLD IN BLACK (${pct}%)`;
        stabLabel.textContent = `HOLD STEADY: ${this.currentHoldInZoneSec.toFixed(2)}s / ${this.requiredHoldSec}s`;
        stabLabel.style.color = '#eab308';
      }
    } else {
      fireBtn.className = 'btn btn-trigger-action unlocked';
      fireBtn.textContent = '🔥 PULL SEAR (DIRECT)';
      stabLabel.textContent =
        this.currentRadialMm <= 29.75
          ? `DEC SCORE EST: ${this.targetGeo.computeDecimalScore(this.currentRadialMm).toFixed(1)}`
          : 'OUTSIDE 59.5mm HIT ZONE';
      stabLabel.style.color = this.currentRadialMm <= 29.75 ? '#22c55e' : '#94a3b8';
    }
  }

  // ===========================================================================
  // RENDERING: 10m ECOAIMS TARGET + LIVE SCATT TRACE + 3D IRON SIGHTS
  // ===========================================================================

  private renderRangeCanvas() {
    const ctx = this.rangeCtx;
    const w = this.rangeCanvas.clientWidth;
    const h = this.rangeCanvas.clientHeight;
    if (w === 0 || h === 0) return;

    ctx.clearRect(0, 0, w, h);

    const cx = w * 0.5;
    const cy = h * 0.47;
    // Scale: 170mm full ISSF target fits comfortably in viewport
    const minDim = Math.min(w, h);
    const pxPerMm = (minDim * 0.74) / 170.0;

    // 1. Subtle 10m Indoor Shooting Lane Background Grid
    ctx.strokeStyle = 'rgba(30, 41, 59, 0.35)';
    ctx.lineWidth = 1;
    const gridStep = 40;
    for (let x = cx % gridStep; x < w; x += gridStep) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = cy % gridStep; y < h; y += gridStep) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // 2. Official UIPM Ecoaims LT600 Target Box Housing (170mm x 170mm cream face)
    const boxHalfPx = 82.0 * pxPerMm;
    ctx.fillStyle = '#e2dcc8'; // ISSF Non-reflecting cream target paper
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(cx - boxHalfPx, cy - boxHalfPx, boxHalfPx * 2, boxHalfPx * 2, 8);
    ctx.fill();
    ctx.stroke();

    // 3. Black Hit Zone (Rings 7, 8, 9, 10, Inner-10 = 59.5mm diameter / 29.75mm radius)
    const blackRadiusPx = this.targetGeo.getHitZoneRadiusMm() * pxPerMm;
    ctx.fillStyle = '#090b10';
    ctx.beginPath();
    ctx.arc(cx, cy, blackRadiusPx, 0, Math.PI * 2);
    ctx.fill();

    // 4. ISSF Concentric Scoring Rings (1 to 10 + Inner X)
    for (let ring = 1; ring <= 11; ring++) {
      const rPx = this.targetGeo.getRingRadiusMm(ring) * pxPerMm;
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      if (ring <= 6) {
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)';
        ctx.lineWidth = 1;
      } else if (ring === 7) {
        ctx.strokeStyle = '#22c55e'; // Highlight 59.5mm UIPM Hit Threshold slightly
        ctx.lineWidth = 1.4;
      } else {
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.35)';
        ctx.lineWidth = 1;
      }
      ctx.stroke();
    }

    // Sub-6 O'Clock Zero Reference Marker if selected
    if (this.sightZeroMode === 'SUB_SIX_HOLD') {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(cx - 24, cy + blackRadiusPx);
      ctx.lineTo(cx + 24, cy + blackRadiusPx);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 5. Previous Shot Impacts in Current Series
    for (const s of this.currentShots) {
      const sx = cx + s.offsetMmX * pxPerMm;
      const sy = cy - s.offsetMmY * pxPerMm;
      ctx.fillStyle = s.isHit ? 'rgba(34, 197, 94, 0.88)' : 'rgba(239, 68, 68, 0.88)';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(s.shotIndex.toString(), sx, sy - 7);
    }

    // 6. Live SCATT Optical Trace (-1000ms Green -> -250ms Yellow)
    if (this.showLiveTrace && this.isTableArmed && this.recentAimTrail.length > 2) {
      const now = performance.now();
      for (let i = 1; i < this.recentAimTrail.length; i++) {
        const p0 = this.recentAimTrail[i - 1];
        const p1 = this.recentAimTrail[i];
        const ageMs = now - p1.tMs;
        ctx.strokeStyle = ageMs <= 250 ? '#eab308' : '#22c55e';
        ctx.lineWidth = ageMs <= 250 ? 2.2 : 1.5;
        ctx.beginPath();
        ctx.moveTo(cx + p0.xMm * pxPerMm, cy - p0.yMm * pxPerMm);
        ctx.lineTo(cx + p1.xMm * pxPerMm, cy - p1.yMm * pxPerMm);
        ctx.stroke();
      }
    }

    // 7. 3D Projected Front & Rear Match Iron Sights + Cant Bubble Level
    const aimPxX = cx + this.currentXMm * pxPerMm;
    // In SUB_SIX_HOLD, when the athlete aims at the center (0,0), the sights are visually held at the bottom edge of the black circle
    const sightVisualOffsetY = this.sightZeroMode === 'SUB_SIX_HOLD' ? blackRadiusPx : 0;
    const aimPxY = cy - this.currentYMm * pxPerMm + sightVisualOffsetY;

    ctx.save();
    ctx.translate(aimPxX, aimPxY);
    ctx.rotate((this.currentCantDeg * Math.PI) / 180.0);

    // Front Sight Post (4.2mm wide match blade)
    const frontShiftPx = this.currentFrontSightShiftMm * pxPerMm * 4.5;
    const postHalfW = 7;
    const postH = 44;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.strokeStyle = this.currentRadialMm <= 29.75 ? '#22c55e' : '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.fillRect(-postHalfW + frontShiftPx, 0, postHalfW * 2, postH);
    ctx.strokeRect(-postHalfW + frontShiftPx, 0, postHalfW * 2, postH);

    // Red/Green Fiber Optic Dot near top of Front Sight Post
    ctx.fillStyle = this.currentRadialMm <= 29.75 ? '#22c55e' : '#f43f5e';
    ctx.beginPath();
    ctx.arc(frontShiftPx, 5, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Rear Sight Notch (Left & Right shoulders with light bars on either side)
    const notchGapHalf = 13;
    const bladeW = 34;
    const bladeH = 38;
    ctx.fillStyle = 'rgba(9, 13, 22, 0.88)';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.6)';
    ctx.lineWidth = 1.2;
    // Left rear blade
    ctx.fillRect(-notchGapHalf - bladeW, 2, bladeW, bladeH);
    ctx.strokeRect(-notchGapHalf - bladeW, 2, bladeW, bladeH);
    // Right rear blade
    ctx.fillRect(notchGapHalf, 2, bladeW, bladeH);
    ctx.strokeRect(notchGapHalf, 2, bladeW, bladeH);

    // Spirit Bubble Cant Level below rear sight
    const levelW = 56;
    const levelY = 46;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.strokeStyle = Math.abs(this.currentCantDeg) > 2.5 ? '#ef4444' : 'rgba(148, 163, 184, 0.5)';
    ctx.beginPath();
    ctx.roundRect(-levelW / 2, levelY, levelW, 8, 4);
    ctx.fill();
    ctx.stroke();

    const bubbleX = Math.max(-20, Math.min(20, -this.currentCantDeg * 3.5));
    ctx.fillStyle = Math.abs(this.currentCantDeg) > 2.5 ? '#ef4444' : '#22c55e';
    ctx.beginPath();
    ctx.arc(bubbleX, levelY + 4, 3.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // ===========================================================================
  // SERIES COMPLETION & INTERACTIVE SCATT REPLAY ANALYZER
  // ===========================================================================

  private completeSeries(isTimedOut: boolean) {
    this.isStationActive = false;
    cancelAnimationFrame(this.animFrameId);

    const totalSec =
      this.stationStartPerfMs > 0
        ? parseFloat(((performance.now() - this.stationStartPerfMs) / 1000.0).toFixed(2))
        : 0;
    const firstShotSec =
      this.currentShots.length > 0 ? this.currentShots[0].timeSinceSeriesStartSec : totalSec;

    const seriesResult = PerformanceAnalytics.computeSeriesMetrics(
      1,
      0,
      0,
      firstShotSec,
      totalSec,
      this.currentShots,
      this.entryBpm,
      Math.round(this.currentBpm),
      this.hrSource,
      this.drillMode
    );
    seriesResult.isTimedOut = isTimedOut;

    SessionStorageExport.saveSeries(seriesResult);
    this.lastSeriesResult = seriesResult;
    this.selectedReplayShotIdx = this.currentShots.length > 0 ? 0 : -1;

    this.populateResultScreen(seriesResult);
    this.switchScreen('view-result');
  }

  private populateResultScreen(series: SeriesResult) {
    const titleEl = document.getElementById('result-status-title');
    if (titleEl) {
      titleEl.textContent = series.isTimedOut
        ? `⏱️ TIME EXPIRED (${series.hitsCleared}/${this.requiredHits} HITS)`
        : `✅ SERIES COMPLETE — ${series.totalRangeStationDurationSec.toFixed(2)}s`;
    }

    // 1. Summary Metrics Table
    const summaryTable = document.getElementById('table-result-metrics');
    if (summaryTable) {
      summaryTable.innerHTML = `
        <tr>
          <td>Total Station Time / First Shot</td>
          <td><strong>${series.totalRangeStationDurationSec.toFixed(2)}s</strong> (1st Shot: <strong>${series.firstShotDurationSec.toFixed(2)}s</strong>)</td>
        </tr>
        <tr>
          <td>Hits / Shots (Hit Accuracy)</td>
          <td><strong>${series.hitsCleared} / ${series.totalShotsFired}</strong> (${series.accuracyPct}%)</td>
        </tr>
        <tr>
          <td>Avg ISSF Decimal Score</td>
          <td><strong style="color:#38bdf8;">${series.avgDecimalScore.toFixed(1)}</strong> / 10.9</td>
        </tr>
        <tr>
          <td>SCATT Avg Muzzle Speed (L)</td>
          <td><strong style="color:${series.avgTraceLengthMmPerSec <= 105 ? '#22c55e' : '#eab308'};">${series.avgTraceLengthMmPerSec.toFixed(1)} mm/s</strong> (Pro Target &lt; 95 mm/s)</td>
        </tr>
        <tr>
          <td>7-Ring Hold Stability &amp; Pull Error</td>
          <td>Stability <strong>${series.avgStability7RingPct}%</strong> • Trigger Pull Err <strong>${series.avgPullErrorMm.toFixed(1)} mm</strong></td>
        </tr>
        <tr>
          <td>Group MPI (X, Y) &amp; Extreme Spread</td>
          <td>MPI (${series.meanPointOfImpactMm.x}mm, ${series.meanPointOfImpactMm.y}mm) • Spread ${series.extremeSpreadMm}mm</td>
        </tr>
      `;
    }

    // 2. Shot-by-Shot Table & Selector Pills
    const pillsContainer = document.getElementById('scatt-shot-pills');
    const tbody = document.getElementById('tbody-shots-breakdown');
    if (pillsContainer && tbody) {
      pillsContainer.innerHTML = '';
      tbody.innerHTML = '';

      // Add "ALL SHOTS" pill
      const allPill = document.createElement('button');
      allPill.className = `shot-pill ${this.selectedReplayShotIdx === -1 ? 'active' : ''}`;
      allPill.textContent = 'ALL SHOTS';
      allPill.addEventListener('click', () => {
        this.selectedReplayShotIdx = -1;
        this.refreshShotPillsAndReplay(series);
      });
      pillsContainer.appendChild(allPill);

      series.shots.forEach((s, idx) => {
        const pill = document.createElement('button');
        pill.className = `shot-pill ${s.isHit ? 'hit-pill' : 'miss-pill'} ${
          this.selectedReplayShotIdx === idx ? 'active' : ''
        }`;
        pill.textContent = `#${s.shotIndex}: ${s.scatt.decimalScore.toFixed(1)} (${s.scatt.clockDirection}h)`;
        pill.addEventListener('click', () => {
          this.selectedReplayShotIdx = idx;
          this.refreshShotPillsAndReplay(series);
        });
        pillsContainer.appendChild(pill);

        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => {
          this.selectedReplayShotIdx = idx;
          this.refreshShotPillsAndReplay(series);
        });
        tr.innerHTML = `
          <td>#${s.shotIndex}</td>
          <td style="color:${s.isHit ? '#22c55e' : '#ef4444'}; font-weight:700;">
            ${s.scatt.decimalScore.toFixed(1)} (${s.scatt.clockDirection}h)
          </td>
          <td>${s.timeSinceSeriesStartSec.toFixed(2)}s (+${s.splitFromPrevShotSec.toFixed(2)}s)</td>
          <td>${s.scatt.traceLengthMmPerSec} mm/s</td>
          <td>${s.scatt.stability7RingPct}%</td>
          <td>${s.scatt.pullErrorMm}mm (${s.scatt.pullDirectionClock}h)</td>
          <td>${s.jerk.isJerk ? `⚠️ ${s.jerk.flinchDirection}` : 'CLEAN'}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    // 3. Coach Diagnostics
    const coachList = document.getElementById('result-coach-tips');
    if (coachList) {
      coachList.innerHTML = series.coachDiagnostics.map(tip => `<li>${tip}</li>`).join('');
    }

    this.refreshShotPillsAndReplay(series);
  }

  private refreshShotPillsAndReplay(series: SeriesResult) {
    const pills = document.querySelectorAll('#scatt-shot-pills .shot-pill');
    pills.forEach((el, i) => {
      const pillIdx = i - 1; // index 0 is ALL SHOTS (-1)
      el.classList.toggle('active', pillIdx === this.selectedReplayShotIdx);
    });

    const detailEl = document.getElementById('scatt-selected-shot-detail');
    if (detailEl) {
      if (this.selectedReplayShotIdx >= 0 && series.shots[this.selectedReplayShotIdx]) {
        const s = series.shots[this.selectedReplayShotIdx];
        detailEl.innerHTML =
          `<strong>Shot #${s.shotIndex} (${s.isHit ? 'HIT' : 'MISS'} ${s.scatt.decimalScore.toFixed(1)} @ ${s.scatt.clockDirection} o'clock):</strong> ` +
          `Trace Speed L = <strong>${s.scatt.traceLengthMmPerSec} mm/s</strong> | ` +
          `7-Ring Hold = <strong>${s.scatt.stability7RingPct}%</strong> | ` +
          `Pull Error = <strong>${s.scatt.pullErrorMm}mm (${s.scatt.pullDirectionClock}h)</strong> | ` +
          `Cant = <strong>${s.scatt.cantAngleAtShotDeg}°</strong>`;
      } else {
        detailEl.innerHTML = `<strong>Overview (${series.totalShotsFired} Shots):</strong> แสดงจุดตกกระทบและศูนย์กลางกลุ่มกระสุน (MPI) ทั้งชุด — แตะปุ่ม #1..#${series.totalShotsFired} ด้านบนเพื่อดูเส้นทาง SCATT ทีละนัด`;
      }
    }

    this.renderScattReplayCanvas(series, this.selectedReplayShotIdx);
  }

  private renderScattReplayCanvas(series: SeriesResult, shotIdx: number) {
    const ctx = this.replayCtx;
    const w = this.replayCanvas.width;
    const h = this.replayCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const pxPerMm = (w * 0.44) / 60.0; // Zoomed in around rings 4..10 so trace is crystal clear

    // Background paper & 59.5mm 7-Ring Hit Zone
    ctx.fillStyle = '#131c2e';
    ctx.fillRect(0, 0, w, h);

    const blackR = 29.75 * pxPerMm;
    ctx.fillStyle = '#070a0f';
    ctx.beginPath();
    ctx.arc(cx, cy, blackR, 0, Math.PI * 2);
    ctx.fill();

    // Draw ISSF Rings 4 to 11
    for (let ring = 4; ring <= 11; ring++) {
      const rPx = this.targetGeo.getRingRadiusMm(ring) * pxPerMm;
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      ctx.strokeStyle = ring === 7 ? '#22c55e' : 'rgba(148, 163, 184, 0.3)';
      ctx.lineWidth = ring === 7 ? 1.5 : 1;
      ctx.stroke();
    }

    // Crosshair lines
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy);
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();

    const drawTraceForShot = (s: ShotRecord, highlight: boolean) => {
      const trace: TracePoint[] = s.trace || [];
      for (let i = 1; i < trace.length; i++) {
        const p0 = trace[i - 1];
        const p1 = trace[i];
        if (p1.tRelMs <= -200) {
          ctx.strokeStyle = highlight ? '#22c55e' : 'rgba(34, 197, 94, 0.3)';
        } else if (p1.tRelMs <= 0) {
          ctx.strokeStyle = highlight ? '#eab308' : 'rgba(234, 179, 8, 0.35)';
        } else {
          ctx.strokeStyle = highlight ? '#38bdf8' : 'rgba(56, 189, 248, 0.3)';
        }
        ctx.lineWidth = highlight ? 2.2 : 1.0;
        ctx.beginPath();
        ctx.moveTo(cx + p0.xMm * pxPerMm, cy - p0.yMm * pxPerMm);
        ctx.lineTo(cx + p1.xMm * pxPerMm, cy - p1.yMm * pxPerMm);
        ctx.stroke();
      }

      // Impact Point
      const ix = cx + s.offsetMmX * pxPerMm;
      const iy = cy - s.offsetMmY * pxPerMm;
      ctx.fillStyle = s.isHit ? '#22c55e' : '#ef4444';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = highlight ? 2 : 1;
      ctx.beginPath();
      ctx.arc(ix, iy, highlight ? 6.5 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`#${s.shotIndex}`, ix, iy - 9);
    };

    if (shotIdx >= 0 && series.shots[shotIdx]) {
      // Draw other shots faintly, then selected shot brightly
      series.shots.forEach((s, idx) => {
        if (idx !== shotIdx) drawTraceForShot(s, false);
      });
      drawTraceForShot(series.shots[shotIdx], true);
    } else {
      series.shots.forEach(s => drawTraceForShot(s, true));
      // Draw Mean Point of Impact (MPI) diamond
      const mx = cx + series.meanPointOfImpactMm.x * pxPerMm;
      const my = cy - series.meanPointOfImpactMm.y * pxPerMm;
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mx, my, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new ScattUipmRangeController();
});
