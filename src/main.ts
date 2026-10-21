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

class PentaArenaController {
  // Configuration State
  private drillMode: DrillMode = 'UIPM_5HIT_SERIES';
  private triggerMode: TriggerMechanicsMode = 'DIRECT_COMPETITION';
  private sightZeroMode: SightZeroMode = 'CENTER_HOLD';
  private requiredHoldSec = 0.9;
  private sensitivityMult = 1.35;
  private showLiveTrace = true;

  // Services
  private targetGeo = new TargetGeometry(10.0, 59.5);
  private biomech = new MotionBiomechanics();
  private bleHr = new HeartRateTelemetry();
  private yawFilter = new OneEuroFilter(4.5, 0.04, 1.0);
  private pitchFilter = new OneEuroFilter(4.5, 0.04, 1.0);
  private rollFilter = new OneEuroFilter(3.5, 0.03, 1.0);

  // Biometrics
  private entryBpm = 174;
  private currentBpm = 174;
  private hrSource: DataSourceType = 'SIMULATED_MODEL';
  private isHoldingBreath = false;
  private lastSystolicPeak = false;
  private currentO2Stress01 = 0;
  private currentDeltoidPct = 0;

  // Cocking Lever State (ระบบสับไกปืน)
  private isPistolCocked = true; // True = in battery ready to fire, False = needs cocking lever cycle

  // Real-Time Gyroscope & Motion Tracking
  public hasGyro = false;
  private lastRawAlpha: number | null = null;
  private gyroContinuousYawDeg = 0;
  private gyroContinuousPitchDeg = 0;
  private zeroYawDeg = 0;
  private zeroPitchDeg = 0;
  private zeroRollDeg = 0;
  private rawRollDeg = 0;
  private latestAccel = { x: 0, y: 0, z: 0 };
  private lastMotionMs = 0;

  // Touch drag offset
  private dragYawDeg = 0;
  private dragPitchDeg = 0;
  private isDragging = false;
  private lastDragX = 0;
  private lastDragY = 0;

  // Desktop Pointer fallback
  private pointerYawDeg = 0;
  private pointerPitchDeg = 0;

  // Live coordinates on 10m target (mm)
  private currentXMm = 0;
  private currentYMm = 0;
  private currentRadialMm = 0;
  private currentCantDeg = 0;
  private currentFrontSightShiftMm = 0;
  private liveTraceSpeedMmPerSec = 0;
  private recentAimTrail: { tMs: number; xMm: number; yMm: number }[] = [];

  // Station Lifecycle
  private isStationActive = false;
  private stationStartPerfMs = 0;
  private lastRaiseFromTableMs = 0;
  private lastShotPerfMs = 0;
  private maxDurationSec = 50.0;
  private requiredHits = 5;
  private maxShotsInDrill = 25;

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

  // Recorded Shots & Replay
  private currentShots: ShotRecord[] = [];
  private hitsCount = 0;
  private lastSeriesResult: SeriesResult | null = null;
  private selectedReplayShotIdx: number = -1;

  // Animation Loop & Canvases
  private animFrameId = 0;
  private lastFrameMs = 0;
  private rangeCanvas!: HTMLCanvasElement;
  private rangeCtx!: CanvasRenderingContext2D;
  private replayCanvas!: HTMLCanvasElement;
  private replayCtx!: CanvasRenderingContext2D;

  constructor() {
    this.rangeCanvas = document.getElementById('range-canvas') as HTMLCanvasElement;
    this.rangeCtx = this.rangeCanvas.getContext('2d')!;
    this.replayCanvas = document.getElementById('scatt-replay-canvas') as HTMLCanvasElement;
    this.replayCtx = this.replayCanvas.getContext('2d')!;

    this.bindDashboardControls();
    this.bindRangeControls();
    this.bindResultControls();
    this.initGyroscope();
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

  // ===========================================================================
  // GYROSCOPE INITIALIZATION & PERMISSION
  // ===========================================================================

  private initGyroscope() {
    const gyroBtn = document.getElementById('btn-gyro-status');
    const gyroText = document.getElementById('gyro-status-text');

    const updateBadge = (active: boolean) => {
      if (!gyroBtn || !gyroText) return;
      if (active) {
        gyroBtn.className = 'gyro-pill-btn active';
        gyroText.textContent = '🟢 ไจโร: เปิดใช้งาน';
      } else {
        gyroBtn.className = 'gyro-pill-btn prompt';
        gyroText.textContent = '📱 แตะเปิดใช้งานไจโร';
      }
    };

    const devOrient = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };

    if (typeof devOrient?.requestPermission === 'function') {
      updateBadge(false);
      gyroBtn?.addEventListener('click', async () => {
        try {
          const res = await devOrient.requestPermission!();
          if (res === 'granted') {
            this.hasGyro = true;
            updateBadge(true);
            this.attachOrientationListeners();
          } else {
            alert('ไม่ได้รับอนุญาตให้ใช้ Gyroscope กรุณาเปิดสิทธิ์ในตั้งค่า Safari');
          }
        } catch (err) {
          console.warn('Gyro permission error:', err);
        }
      });
    } else {
      this.attachOrientationListeners();
    }
  }

  private attachOrientationListeners() {
    const gyroBtn = document.getElementById('btn-gyro-status');
    const gyroText = document.getElementById('gyro-status-text');

    window.addEventListener('deviceorientation', (e) => {
      if (e.alpha !== null && e.beta !== null) {
        if (!this.hasGyro) {
          this.hasGyro = true;
          if (gyroBtn && gyroText) {
            gyroBtn.className = 'gyro-pill-btn active';
            gyroText.textContent = '🟢 ไจโร: พร้อมใช้งาน';
          }
        }

        if (this.lastRawAlpha !== null) {
          let deltaAlpha = e.alpha - this.lastRawAlpha;
          if (deltaAlpha > 180) deltaAlpha -= 360;
          if (deltaAlpha < -180) deltaAlpha += 360;
          this.gyroContinuousYawDeg -= deltaAlpha;
        } else {
          this.zeroYawDeg = 0;
          this.gyroContinuousYawDeg = 0;
        }
        this.lastRawAlpha = e.alpha;

        this.gyroContinuousPitchDeg = e.beta;
        this.rawRollDeg = e.gamma || 0;
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

      const rot = e.rotationRate;
      const now = performance.now();
      if (rot && this.lastMotionMs > 0) {
        const dt = Math.min(0.04, (now - this.lastMotionMs) / 1000.0);
        if (dt > 0.002) {
          if (rot.alpha !== null && Math.abs(rot.alpha) > 0.1) {
            this.gyroContinuousYawDeg += rot.alpha * dt * 0.45;
          }
          if (rot.beta !== null && Math.abs(rot.beta) > 0.1) {
            this.gyroContinuousPitchDeg += rot.beta * dt * 0.45;
          }
        }
      }
      this.lastMotionMs = now;
    });
  }

  public recenterAim() {
    this.zeroYawDeg = this.gyroContinuousYawDeg;
    this.zeroPitchDeg = this.gyroContinuousPitchDeg;
    this.zeroRollDeg = this.rawRollDeg;
    this.dragYawDeg = 0;
    this.dragPitchDeg = 0;
    this.pointerYawDeg = 0;
    this.pointerPitchDeg = 0;
    this.yawFilter.reset();
    this.pitchFilter.reset();
    this.rollFilter.reset();
    this.biomech.resetDeltoidFatigue();

    const readout = document.getElementById('hud-last-shot-readout');
    if (readout) {
      readout.textContent = '🎯 SIGHTS RECENTERED (ZERO OK)';
      readout.style.color = '#38bdf8';
    }
  }

  // ===========================================================================
  // COCKING LEVER MECHANISM (สับไกปืน)
  // ===========================================================================

  public cockPistol() {
    if (this.isPistolCocked) return; // already cocked
    this.isPistolCocked = true;
    sfx.playCockLever();
    if (navigator.vibrate) navigator.vibrate(15);
    this.updatePistolCockUI();
  }

  private updatePistolCockUI() {
    const cockStatus = document.getElementById('cock-status-text');
    const cockBtn = document.getElementById('btn-cock-lever');
    const fireBtn = document.getElementById('btn-fire');

    if (this.isPistolCocked) {
      if (cockStatus) {
        cockStatus.textContent = 'พร้อมยิง';
        cockStatus.style.color = '#22c55e';
      }
      if (cockBtn) {
        cockBtn.className = 'btn-hud-cock';
        cockBtn.textContent = '✅ สับไกแล้ว';
      }
      if (fireBtn) {
        fireBtn.className = 'btn-hud-fire ready';
        fireBtn.textContent = '🔥 เหนี่ยวไก (FIRE)';
      }
    } else {
      if (cockStatus) {
        cockStatus.textContent = '⚡ ต้องสับไก';
        cockStatus.style.color = '#facc15';
      }
      if (cockBtn) {
        cockBtn.className = 'btn-hud-cock needs-cock';
        cockBtn.textContent = '🔄 สับไกปืน (COCK)';
      }
      if (fireBtn) {
        fireBtn.className = 'btn-hud-fire uncocked';
        fireBtn.textContent = '⚡ สับไกก่อนยิง (COCK)';
      }
    }
  }

  // ===========================================================================
  // DASHBOARD CONTROLS
  // ===========================================================================

  private bindDashboardControls() {
    // 1. Drill Cards
    const drillCards = document.querySelectorAll('.drill-card');
    drillCards.forEach(card => {
      card.addEventListener('click', () => {
        drillCards.forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        const mode = card.getAttribute('data-drill') as DrillMode;
        if (mode) {
          this.drillMode = mode;
          const badge = document.getElementById('selected-drill-badge');
          if (badge) {
            badge.textContent = card.querySelector('.drill-card-title')?.textContent || '';
          }
        }
      });
    });

    // 2. Trigger Action Pills
    const triggerPills = document.querySelectorAll('#trigger-mode-pills .pill-btn');
    triggerPills.forEach(pill => {
      pill.addEventListener('click', () => {
        triggerPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        const val = pill.getAttribute('data-val') as TriggerMechanicsMode;
        if (val) this.triggerMode = val;
      });
    });

    // 3. Heart Rate Pills
    const hrPills = document.querySelectorAll('#hr-mode-pills .pill-btn');
    hrPills.forEach(pill => {
      pill.addEventListener('click', () => {
        hrPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        const val = parseInt(pill.getAttribute('data-val') || '174', 10);
        if (this.hrSource !== 'HARDWARE_BLE') {
          this.entryBpm = val;
          this.currentBpm = val;
        }
      });
    });

    // 4. Sight Zero Pills
    const sightPills = document.querySelectorAll('#sight-mode-pills .pill-btn');
    sightPills.forEach(pill => {
      pill.addEventListener('click', () => {
        sightPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        const val = pill.getAttribute('data-val') as SightZeroMode;
        if (val) this.sightZeroMode = val;
      });
    });

    // 5. Sound Toggle
    const soundBtn = document.getElementById('btn-sound-toggle');
    soundBtn?.addEventListener('click', () => {
      sfx.muted = !sfx.muted;
      soundBtn.textContent = sfx.muted ? '🔇' : '🔊';
    });

    // 6. Connect BLE
    document.getElementById('btn-connect-ble')?.addEventListener('click', async () => {
      this.bleHr.subscribe((bpm, source) => {
        if (source === 'HARDWARE_BLE') {
          this.currentBpm = bpm;
          this.entryBpm = bpm;
          this.hrSource = 'HARDWARE_BLE';
          const btn = document.getElementById('btn-connect-ble');
          if (btn) btn.textContent = `💚 BLE: ${bpm} BPM`;
        }
      });
      const ok = await this.bleHr.connectBleSensor();
      if (!ok) {
        alert('ไม่พบสายคาดอก Bluetooth Heart Rate — ระบบใช้โมเดลจำลองคลื่นชีพจรตามความเหนื่อยแทน');
      }
    });

    // 7. Enter Range Button
    document.getElementById('btn-enter-range')?.addEventListener('click', async () => {
      const devOrient = window.DeviceOrientationEvent as unknown as {
        requestPermission?: () => Promise<'granted' | 'denied'>;
      };
      if (typeof devOrient?.requestPermission === 'function' && !this.hasGyro) {
        try {
          const res = await devOrient.requestPermission();
          if (res === 'granted') {
            this.hasGyro = true;
            this.attachOrientationListeners();
          }
        } catch {
          // ignore
        }
      }
      this.startRangeSession();
    });
  }

  // ===========================================================================
  // RANGE CONTROLS & BREATH HOLD (+5% STEADIER AIM)
  // ===========================================================================

  private setBreathHold(active: boolean) {
    this.isHoldingBreath = active;
    const breathBtn = document.getElementById('btn-breath-hold');
    const breathText = document.getElementById('breath-status-text');

    if (active) {
      breathBtn?.classList.add('active');
      if (breathText) {
        breathText.textContent = 'ON (+5% นิ่ง)';
        breathText.style.color = '#06b6d4';
      }
    } else {
      breathBtn?.classList.remove('active');
      if (breathText) {
        breathText.textContent = 'OFF';
        breathText.style.color = '#94a3b8';
      }
    }
  }

  private toggleBreathHold() {
    this.setBreathHold(!this.isHoldingBreath);
  }

  private bindRangeControls() {
    // Back to Lobby
    document.getElementById('btn-range-exit')?.addEventListener('click', () => {
      this.isStationActive = false;
      cancelAnimationFrame(this.animFrameId);
      this.switchScreen('view-setup');
    });

    // Recenter Button
    document.getElementById('btn-recenter-aim')?.addEventListener('click', () => {
      this.recenterAim();
    });

    // Breath Hold Button: supports both Click-to-Toggle and Touch-Hold
    const breathBtn = document.getElementById('btn-breath-hold');
    breathBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleBreathHold();
    });

    // Cocking Lever Button
    const cockBtn = document.getElementById('btn-cock-lever');
    cockBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.cockPistol();
    });

    // Trigger Button (Fire)
    const fireBtn = document.getElementById('btn-fire');
    fireBtn?.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.isPistolCocked) {
        // If not cocked, tapping fire button immediately cocks the lever for convenience!
        this.cockPistol();
      } else {
        this.onTriggerPressStart();
      }
    });

    fireBtn?.addEventListener('pointerup', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.isPistolCocked) {
        this.onTriggerRelease();
      }
    });

    // Touch Drag & Tap to Shoot on Canvas
    this.rangeCanvas.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      this.lastDragX = e.clientX;
      this.lastDragY = e.clientY;

      // In Direct mode: tapping screen fires if cocked, or cocks if uncocked!
      if (this.triggerMode === 'DIRECT_COMPETITION' && this.isStationActive && !this.pendingFollowThroughShot) {
        if (!this.isPistolCocked) {
          this.cockPistol();
        } else {
          this.initiateShotBreak();
        }
      }
    });

    this.rangeCanvas.addEventListener('pointermove', (e) => {
      if (this.isDragging) {
        const dx = e.clientX - this.lastDragX;
        const dy = e.clientY - this.lastDragY;
        this.lastDragX = e.clientX;
        this.lastDragY = e.clientY;
        this.dragYawDeg += dx * 0.045;
        this.dragPitchDeg -= dy * 0.045;
      }

      if (!this.hasGyro) {
        const rect = this.rangeCanvas.getBoundingClientRect();
        const nx = ((e.clientX - rect.left) / rect.width - 0.5) * 2.0;
        const ny = (0.5 - (e.clientY - rect.top) / rect.height) * 2.0;
        this.pointerYawDeg = nx * 0.75;
        this.pointerPitchDeg = ny * 0.75;
      }
    });

    const stopDrag = () => {
      this.isDragging = false;
    };
    this.rangeCanvas.addEventListener('pointerup', stopDrag);
    this.rangeCanvas.addEventListener('pointercancel', stopDrag);

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (!this.isStationActive) return;
      if (e.code === 'KeyC') {
        this.cockPistol();
      } else if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        if (!this.isPistolCocked) {
          this.cockPistol();
        } else {
          this.onTriggerPressStart();
        }
      } else if (e.key === 'Shift') {
        this.setBreathHold(true);
      } else if (e.code === 'KeyR') {
        this.recenterAim();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (!this.isStationActive) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (this.isPistolCocked) this.onTriggerRelease();
      } else if (e.key === 'Shift') {
        this.setBreathHold(false);
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
  // SESSION LIFECYCLE
  // ===========================================================================

  private startRangeSession() {
    this.switchScreen('view-range');
    this.isStationActive = true;
    this.isPistolCocked = true; // First shot starts ready
    this.stationStartPerfMs = performance.now();
    this.lastRaiseFromTableMs = this.stationStartPerfMs;
    this.currentShots = [];
    this.hitsCount = 0;
    this.recentAimTrail = [];
    this.pendingFollowThroughShot = null;
    this.isStage1Held = false;
    this.currentHoldInZoneSec = 0;
    this.biomech.deltoidHoldSec = 0;
    this.biomech.currentBreathHoldSec = 0;
    this.setBreathHold(false);
    this.recenterAim();
    this.updatePistolCockUI();

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

    for (let i = 1; i <= 5; i++) {
      const lamp = document.getElementById(`lamp-dot-${i}`);
      if (lamp) lamp.className = 'lamp-circle';
    }

    const readout = document.getElementById('hud-last-shot-readout');
    if (readout) {
      readout.textContent = 'READY — ARMED';
      readout.style.color = '#38bdf8';
    }

    this.lastFrameMs = performance.now();
    cancelAnimationFrame(this.animFrameId);
    this.animFrameId = requestAnimationFrame((t) => this.loopRange(t));
  }

  // ===========================================================================
  // TRIGGER ACTIONS (Direct, 2-Stage)
  // ===========================================================================

  private onTriggerPressStart() {
    if (!this.isStationActive || this.pendingFollowThroughShot) return;

    if (!this.isPistolCocked) {
      sfx.playJerk();
      this.updatePistolCockUI();
      return;
    }

    if (this.triggerMode === 'DIRECT_COMPETITION') {
      this.initiateShotBreak();
    } else if (this.triggerMode === 'TWO_STAGE_RELEASE') {
      this.isStage1Held = true;
      this.stage1StartMs = performance.now();
      sfx.playTakeUp();
      const fireBtn = document.getElementById('btn-fire');
      if (fireBtn) fireBtn.textContent = '⚡ WALL LOCKED — RELEASE';
    }
  }

  private onTriggerRelease() {
    if (!this.isStationActive) return;
    const fireBtn = document.getElementById('btn-fire');
    if (fireBtn && this.isPistolCocked) {
      fireBtn.textContent = '🔥 เหนี่ยวไก (FIRE)';
    }

    if (this.triggerMode === 'TWO_STAGE_RELEASE' && this.isStage1Held && this.isPistolCocked) {
      this.isStage1Held = false;
      if (!this.pendingFollowThroughShot) {
        this.initiateShotBreak();
      }
    }
  }

  private initiateShotBreak() {
    if (!this.isPistolCocked) return;

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

    // After firing, pistol is spent and needs cocking lever cycle!
    this.isPistolCocked = false;
    this.updatePistolCockUI();

    const isHit = this.targetGeo.evaluateHit(this.currentRadialMm, 1.0);

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

    const jerkAlert = document.getElementById('range-jerk-alert');
    if (jerk.isJerk && jerkAlert) {
      jerkAlert.textContent = `⚠️ FLINCH (${jerk.flinchDirection}) — Pull Error ${scatt.pullErrorMm}mm`;
      jerkAlert.classList.add('visible');
      sfx.playJerk();
      setTimeout(() => jerkAlert.classList.remove('visible'), 1500);
    }

    const readout = document.getElementById('hud-last-shot-readout');
    if (p.isHit) {
      this.hitsCount++;
      sfx.playHit();
      const lampIdx = ((this.hitsCount - 1) % 5) + 1;
      const lamp = document.getElementById(`lamp-dot-${lampIdx}`);
      if (lamp) lamp.className = 'lamp-circle hit';
      if (readout) {
        readout.textContent = `HIT ${scatt.decimalScore.toFixed(1)} (${scatt.clockDirection}h) • ${p.splitSec.toFixed(2)}s`;
        readout.style.color = '#22c55e';
      }
    } else {
      const lampIdx = (this.hitsCount % 5) + 1;
      const lamp = document.getElementById(`lamp-dot-${lampIdx}`);
      if (lamp) {
        lamp.className = 'lamp-circle miss-flash';
        setTimeout(() => {
          if (lamp.classList.contains('miss-flash')) lamp.className = 'lamp-circle';
        }, 500);
      }
      if (readout) {
        readout.textContent = `MISS ${scatt.decimalScore.toFixed(1)} (${scatt.clockDirection}h) • Err ${scatt.pullErrorMm}mm`;
        readout.style.color = '#ef4444';
      }
    }

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
  // 60 FPS MAIN LOOP
  // ===========================================================================

  private loopRange(nowMs: number) {
    if (!this.isStationActive) return;

    const dtSec = Math.min(0.1, Math.max(0.001, (nowMs - this.lastFrameMs) / 1000.0));
    this.lastFrameMs = nowMs;

    let elapsedSec = (nowMs - this.stationStartPerfMs) / 1000.0;
    const remainingSec = Math.max(0, this.maxDurationSec - elapsedSec);
    const timerEl = document.getElementById('range-countdown-val');
    if (timerEl) {
      timerEl.innerHTML = `${remainingSec.toFixed(1)}<span>s</span>`;
      timerEl.style.color = remainingSec <= 10.0 ? '#ef4444' : '#ffffff';
    }

    if (remainingSec <= 0) {
      this.completeSeries(true);
      return;
    }

    if (this.drillMode === 'CADENCE_METRONOME' && elapsedSec >= this.nextMetronomeTickSec) {
      sfx.playMetronomeTick();
      this.nextMetronomeTickSec += this.cadenceIntervalSec;
    }

    const phys = this.biomech.stepPhysiology(
      dtSec,
      this.currentBpm,
      this.isHoldingBreath,
      true
    );
    this.currentO2Stress01 = phys.hypoxicStress01;
    this.currentDeltoidPct = phys.deltoidFatiguePct;

    if (phys.isSystolicPeak && !this.lastSystolicPeak) {
      const pulseDot = document.getElementById('hud-pulse-dot');
      pulseDot?.classList.add('beat');
      if (this.currentBpm >= 140) {
        sfx.playHeartbeat(Math.min(1, (this.currentBpm - 100) / 90));
      }
      setTimeout(() => pulseDot?.classList.remove('beat'), 110);
    }
    this.lastSystolicPeak = phys.isSystolicPeak;

    // FUSE ORIENTATION SENSORS + DRAG + BREATH-HOLD STABILIZATION (+5% STEADIER AIM)
    let targetYawDeg = 0;
    let targetPitchDeg = 0;
    let targetRollDeg = 0;

    if (this.hasGyro) {
      targetYawDeg = (this.gyroContinuousYawDeg - this.zeroYawDeg) * 0.32 * this.sensitivityMult;
      targetPitchDeg = (this.gyroContinuousPitchDeg - this.zeroPitchDeg) * 0.32 * this.sensitivityMult;
      targetRollDeg = this.rawRollDeg - this.zeroRollDeg;
    } else {
      targetYawDeg = this.pointerYawDeg * this.sensitivityMult;
      targetPitchDeg = this.pointerPitchDeg * this.sensitivityMult;
    }

    targetYawDeg += this.dragYawDeg;
    targetPitchDeg += this.dragPitchDeg;

    // 🫁 BREATH-HOLD STABILIZATION:
    // If breath is held, visibly stabilize aim and hand tremor by ~5% (damping factor 0.95)
    // and reduce physiological sway amplitude by 35%
    const breathStabilityFactor = this.isHoldingBreath ? 0.95 : 1.0;
    const swayDamping = this.isHoldingBreath ? 0.65 : 1.0;

    targetYawDeg *= breathStabilityFactor;
    targetPitchDeg *= breathStabilityFactor;

    const totalYaw = this.yawFilter.filter(targetYawDeg + phys.swayYawDeg * swayDamping, dtSec);
    const totalPitch = this.pitchFilter.filter(targetPitchDeg + phys.swayPitchDeg * swayDamping, dtSec);
    this.currentCantDeg = this.rollFilter.filter(targetRollDeg, dtSec);
    this.currentFrontSightShiftMm = phys.frontSightPulseMm * (this.isHoldingBreath ? 0.8 : 1.0);

    const coords = this.targetGeo.anglesToTargetMm(
      totalYaw,
      totalPitch,
      this.currentCantDeg,
      this.currentFrontSightShiftMm
    );
    this.currentXMm = coords.xMm * breathStabilityFactor;
    this.currentYMm = coords.yMm * breathStabilityFactor;
    this.currentRadialMm = coords.radialErrorMm * breathStabilityFactor;

    this.biomech.pushSample({
      timestampMs: nowMs,
      yawDeg: totalYaw,
      pitchDeg: totalPitch,
      rollDeg: this.currentCantDeg,
      accelX: this.latestAccel.x,
      accelY: this.latestAccel.y,
      accelZ: this.latestAccel.z,
      xMm: this.currentXMm,
      yMm: this.currentYMm,
      frontSightShiftMm: this.currentFrontSightShiftMm
    });

    this.recentAimTrail.push({ tMs: nowMs, xMm: this.currentXMm, yMm: this.currentYMm });
    while (this.recentAimTrail.length > 0 && nowMs - this.recentAimTrail[0].tMs > 1000) {
      this.recentAimTrail.shift();
    }
    this.computeLiveTraceSpeed();

    if (this.pendingFollowThroughShot && nowMs - this.pendingFollowThroughShot.shotPerfMs >= 160) {
      this.finalizePendingShot();
      if (!this.isStationActive) return;
    }

    this.updateHudTelemetry();
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
    const spanSec = (this.recentAimTrail[this.recentAimTrail.length - 1].tMs - this.recentAimTrail[0].tMs) / 1000.0;
    this.liveTraceSpeedMmPerSec = spanSec > 0.05 ? Math.round(dist / spanSec) : 0;
  }

  private updateHudTelemetry() {
    const bpmEl = document.getElementById('hud-bpm-val');
    if (bpmEl) bpmEl.textContent = Math.round(this.currentBpm).toString();

    const speedEl = document.getElementById('hud-trace-speed');
    if (speedEl) {
      speedEl.textContent = this.liveTraceSpeedMmPerSec.toString();
      speedEl.style.color = this.liveTraceSpeedMmPerSec <= 100 ? '#22c55e' : '#f59e0b';
    }

    const cantEl = document.getElementById('hud-cant-deg');
    if (cantEl) {
      cantEl.textContent = `${this.currentCantDeg >= 0 ? '+' : ''}${this.currentCantDeg.toFixed(1)}°`;
      cantEl.style.color = Math.abs(this.currentCantDeg) > 2.5 ? '#ef4444' : '#ffffff';
    }
  }

  // ===========================================================================
  // CANVAS RENDERING
  // ===========================================================================

  private renderRangeCanvas() {
    const ctx = this.rangeCtx;
    const w = this.rangeCanvas.clientWidth;
    const h = this.rangeCanvas.clientHeight;
    if (w === 0 || h === 0) return;

    ctx.clearRect(0, 0, w, h);
    const cx = w * 0.5;
    const cy = h * 0.48;
    const minDim = Math.min(w, h);
    const pxPerMm = (minDim * 0.72) / 170.0;

    // Background
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, w, h);

    // Ecoaims Target Paper
    const boxHalfPx = 80.0 * pxPerMm;
    ctx.fillStyle = '#e2dcc8';
    ctx.beginPath();
    ctx.roundRect(cx - boxHalfPx, cy - boxHalfPx, boxHalfPx * 2, boxHalfPx * 2, 10);
    ctx.fill();

    // Black Hit Zone
    const blackRadiusPx = 29.75 * pxPerMm;
    ctx.fillStyle = '#090b10';
    ctx.beginPath();
    ctx.arc(cx, cy, blackRadiusPx, 0, Math.PI * 2);
    ctx.fill();

    // Scoring Rings
    for (let ring = 1; ring <= 11; ring++) {
      const rPx = this.targetGeo.getRingRadiusMm(ring) * pxPerMm;
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      ctx.strokeStyle = ring === 7 ? '#22c55e' : (ring <= 6 ? 'rgba(15, 23, 42, 0.4)' : 'rgba(255, 255, 255, 0.3)');
      ctx.lineWidth = ring === 7 ? 1.6 : 1;
      ctx.stroke();
    }

    // Previous Shots
    for (const s of this.currentShots) {
      const sx = cx + s.offsetMmX * pxPerMm;
      const sy = cy - s.offsetMmY * pxPerMm;
      ctx.fillStyle = s.isHit ? '#22c55e' : '#ef4444';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Live SCATT Trace
    if (this.showLiveTrace && this.recentAimTrail.length > 2) {
      const now = performance.now();
      for (let i = 1; i < this.recentAimTrail.length; i++) {
        const p0 = this.recentAimTrail[i - 1];
        const p1 = this.recentAimTrail[i];
        const ageMs = now - p1.tMs;
        ctx.strokeStyle = ageMs <= 220 ? '#eab308' : '#22c55e';
        ctx.lineWidth = ageMs <= 220 ? 2.2 : 1.4;
        ctx.beginPath();
        ctx.moveTo(cx + p0.xMm * pxPerMm, cy - p0.yMm * pxPerMm);
        ctx.lineTo(cx + p1.xMm * pxPerMm, cy - p1.yMm * pxPerMm);
        ctx.stroke();
      }
    }

    // 3D Match Iron Sights
    const aimPxX = cx + this.currentXMm * pxPerMm;
    const visualOffset = this.sightZeroMode === 'SUB_SIX_HOLD' ? blackRadiusPx : 0;
    const aimPxY = cy - this.currentYMm * pxPerMm + visualOffset;

    ctx.save();
    ctx.translate(aimPxX, aimPxY);
    ctx.rotate((this.currentCantDeg * Math.PI) / 180.0);

    const frontShift = this.currentFrontSightShiftMm * pxPerMm * 4;
    const postW = 14;
    const postH = 42;
    ctx.fillStyle = '#0f172a';
    ctx.strokeStyle = this.currentRadialMm <= 29.75 ? '#22c55e' : (this.isHoldingBreath ? '#06b6d4' : '#38bdf8');
    ctx.lineWidth = 1.5;
    ctx.fillRect(-postW / 2 + frontShift, 0, postW, postH);
    ctx.strokeRect(-postW / 2 + frontShift, 0, postW, postH);

    ctx.fillStyle = this.currentRadialMm <= 29.75 ? '#22c55e' : '#ef4444';
    ctx.beginPath();
    ctx.arc(frontShift, 5, 2.5, 0, Math.PI * 2);
    ctx.fill();

    const notchGap = 26;
    const shoulderW = 34;
    const shoulderH = 36;
    ctx.fillStyle = 'rgba(9, 13, 22, 0.9)';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.6)';
    ctx.lineWidth = 1.2;
    ctx.fillRect(-notchGap / 2 - shoulderW, 2, shoulderW, shoulderH);
    ctx.strokeRect(-notchGap / 2 - shoulderW, 2, shoulderW, shoulderH);
    ctx.fillRect(notchGap / 2, 2, shoulderW, shoulderH);
    ctx.strokeRect(notchGap / 2, 2, shoulderW, shoulderH);

    ctx.restore();
  }

  // ===========================================================================
  // SERIES COMPLETION & SCATT REPLAY
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

    const res = PerformanceAnalytics.computeSeriesMetrics(
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
    res.isTimedOut = isTimedOut;
    SessionStorageExport.saveSeries(res);
    this.lastSeriesResult = res;
    this.selectedReplayShotIdx = this.currentShots.length > 0 ? 0 : -1;

    this.populateResultScreen(res);
    this.switchScreen('view-result');
  }

  private populateResultScreen(series: SeriesResult) {
    const titleEl = document.getElementById('result-status-title');
    if (titleEl) {
      titleEl.textContent = series.isTimedOut
        ? `⏱️ หมดเวลา (${series.hitsCleared}/${this.requiredHits} HITS)`
        : `✅ SERIES COMPLETE — ${series.totalRangeStationDurationSec.toFixed(2)}s`;
    }

    const summaryTable = document.getElementById('table-result-metrics');
    if (summaryTable) {
      summaryTable.innerHTML = `
        <tr>
          <td>เวลาเข้าช่องยิงรวม</td>
          <td><strong>${series.totalRangeStationDurationSec.toFixed(2)}s</strong> (นัดแรก: <strong>${series.firstShotDurationSec.toFixed(2)}s</strong>)</td>
        </tr>
        <tr>
          <td>จำนวนเข้าเป้า</td>
          <td><strong>${series.hitsCleared} / ${series.totalShotsFired}</strong> (${series.accuracyPct}%)</td>
        </tr>
        <tr>
          <td>คะแนนทศนิยมเฉลี่ย (ISSF)</td>
          <td><strong style="color:#2563eb;">${series.avgDecimalScore.toFixed(1)}</strong> / 10.9</td>
        </tr>
        <tr>
          <td>SCATT Speed (L)</td>
          <td><strong>${series.avgTraceLengthMmPerSec.toFixed(1)} mm/s</strong></td>
        </tr>
      `;
    }

    const pillsRow = document.getElementById('scatt-shot-pills');
    const tbody = document.getElementById('tbody-shots-breakdown');
    if (pillsRow && tbody) {
      pillsRow.innerHTML = '';
      tbody.innerHTML = '';

      const allPill = document.createElement('button');
      allPill.className = `shot-pill ${this.selectedReplayShotIdx === -1 ? 'active' : ''}`;
      allPill.textContent = 'ALL';
      allPill.addEventListener('click', () => {
        this.selectedReplayShotIdx = -1;
        this.refreshReplay(series);
      });
      pillsRow.appendChild(allPill);

      series.shots.forEach((s, idx) => {
        const pill = document.createElement('button');
        pill.className = `shot-pill ${this.selectedReplayShotIdx === idx ? 'active' : ''}`;
        pill.textContent = `#${s.shotIndex}: ${s.scatt.decimalScore.toFixed(1)}`;
        pill.addEventListener('click', () => {
          this.selectedReplayShotIdx = idx;
          this.refreshReplay(series);
        });
        pillsRow.appendChild(pill);

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>#${s.shotIndex}</td>
          <td style="color:${s.isHit ? '#16a34a' : '#dc2626'}; font-weight:700;">
            ${s.scatt.decimalScore.toFixed(1)}
          </td>
          <td>${s.splitFromPrevShotSec.toFixed(2)}s</td>
          <td>${s.scatt.traceLengthMmPerSec}</td>
          <td>${s.scatt.stability7RingPct}%</td>
          <td>${s.jerk.isJerk ? `⚠️ FLINCH` : 'CLEAN'}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    const coachList = document.getElementById('result-coach-tips');
    if (coachList) {
      coachList.innerHTML = series.coachDiagnostics.map(t => `<li>${t}</li>`).join('');
    }

    this.refreshReplay(series);
  }

  private refreshReplay(series: SeriesResult) {
    const pills = document.querySelectorAll('#scatt-shot-pills .shot-pill');
    pills.forEach((p, idx) => {
      p.classList.toggle('active', idx - 1 === this.selectedReplayShotIdx);
    });

    const detailBox = document.getElementById('scatt-selected-shot-detail');
    if (detailBox) {
      if (this.selectedReplayShotIdx >= 0 && series.shots[this.selectedReplayShotIdx]) {
        const s = series.shots[this.selectedReplayShotIdx];
        detailBox.innerHTML = `
          <strong>นัดที่ #${s.shotIndex} (${s.isHit ? 'เข้าเป้า' : 'หลุดเป้า'} ${s.scatt.decimalScore.toFixed(1)} @ ${s.scatt.clockDirection}h):</strong> 
          ความเร็ว L = <strong>${s.scatt.traceLengthMmPerSec} mm/s</strong> | 
          ระยะกระตุกไก = <strong>${s.scatt.pullErrorMm}mm</strong> | 
          เอียง = <strong>${s.scatt.cantAngleAtShotDeg}°</strong>
        `;
      } else {
        detailBox.innerHTML = `ภาพรวมทั้งชุด (${series.totalShotsFired} นัด) — แตะหมายเลขด้านบนเพื่อดูวิถี SCATT`;
      }
    }

    this.renderScattReplay(series, this.selectedReplayShotIdx);
  }

  private renderScattReplay(series: SeriesResult, shotIdx: number) {
    const ctx = this.replayCtx;
    const w = this.replayCanvas.width;
    const h = this.replayCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const pxPerMm = (w * 0.44) / 60.0;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#020617';
    ctx.beginPath();
    ctx.arc(cx, cy, 29.75 * pxPerMm, 0, Math.PI * 2);
    ctx.fill();

    for (let r = 4; r <= 11; r++) {
      ctx.beginPath();
      ctx.arc(cx, cy, this.targetGeo.getRingRadiusMm(r) * pxPerMm, 0, Math.PI * 2);
      ctx.strokeStyle = r === 7 ? '#22c55e' : 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = r === 7 ? 1.5 : 1;
      ctx.stroke();
    }

    const drawTrace = (s: ShotRecord, highlight: boolean) => {
      const trace: TracePoint[] = s.trace || [];
      for (let i = 1; i < trace.length; i++) {
        const p0 = trace[i - 1];
        const p1 = trace[i];
        if (p1.tRelMs <= -200) {
          ctx.strokeStyle = highlight ? '#22c55e' : 'rgba(34, 197, 94, 0.25)';
        } else if (p1.tRelMs <= 0) {
          ctx.strokeStyle = highlight ? '#eab308' : 'rgba(234, 179, 8, 0.25)';
        } else {
          ctx.strokeStyle = highlight ? '#38bdf8' : 'rgba(56, 189, 248, 0.25)';
        }
        ctx.lineWidth = highlight ? 2.2 : 1.0;
        ctx.beginPath();
        ctx.moveTo(cx + p0.xMm * pxPerMm, cy - p0.yMm * pxPerMm);
        ctx.lineTo(cx + p1.xMm * pxPerMm, cy - p1.yMm * pxPerMm);
        ctx.stroke();
      }

      const ix = cx + s.offsetMmX * pxPerMm;
      const iy = cy - s.offsetMmY * pxPerMm;
      ctx.fillStyle = s.isHit ? '#22c55e' : '#ef4444';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = highlight ? 2 : 1;
      ctx.beginPath();
      ctx.arc(ix, iy, highlight ? 6.5 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };

    if (shotIdx >= 0 && series.shots[shotIdx]) {
      series.shots.forEach((s, i) => {
        if (i !== shotIdx) drawTrace(s, false);
      });
      drawTrace(series.shots[shotIdx], true);
    } else {
      series.shots.forEach(s => drawTrace(s, true));
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new PentaArenaController();
});
