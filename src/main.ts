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
  private yawFilter = new OneEuroFilter(4.5, 0.04, 1.0);
  private pitchFilter = new OneEuroFilter(4.5, 0.04, 1.0);
  private rollFilter = new OneEuroFilter(3.5, 0.03, 1.0);

  // Biometrics
  private entryBpm = 174;
  private currentBpm = 174;
  private isHoldingBreath = false;
  private currentBreathHoldSec = 0; // Strictly max 3.0s per activation
  private lastSystolicPeak = false;
  private currentO2Stress01 = 0;
  private currentDeltoidPct = 0;

  // Cocking Lever State (ระบบสับไกปืน)
  private isPistolCocked = true;

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

  // Station & Rep Lifecycle
  private isStationActive = false;
  private stationStartPerfMs = 0;
  private repStartPerfMs = 0; // For Mode 2 strict 2.50s timer per shot
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

  // Cadence Metronome (Mode 4)
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
    this.updateSoundButtons();
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
  // GYROSCOPE INITIALIZATION & SENSORS
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
  // SOUND CONTROL (Mute / Unmute)
  // ===========================================================================

  public toggleMute() {
    sfx.muted = !sfx.muted;
    this.updateSoundButtons();
  }

  private updateSoundButtons() {
    const navSoundBtn = document.getElementById('btn-sound-toggle');
    const rangeSoundBtn = document.getElementById('btn-range-sound');
    const text = sfx.muted ? '🔇' : '🔊';
    if (navSoundBtn) navSoundBtn.textContent = text;
    if (rangeSoundBtn) rangeSoundBtn.textContent = text;
  }

  // ===========================================================================
  // COCKING LEVER MECHANISM (สับไกปืน)
  // ===========================================================================

  public cockPistol() {
    if (this.isPistolCocked) return;
    this.isPistolCocked = true;
    sfx.playCockLever();
    if (navigator.vibrate) navigator.vibrate(15);
    this.updatePistolCockUI();

    // In Mode 2 (First-Shot Drill), cocking resets the 2.50s countdown for the next rep!
    if (this.drillMode === 'FIRST_SHOT_DRILL') {
      this.repStartPerfMs = performance.now();
      const readout = document.getElementById('hud-last-shot-readout');
      if (readout) {
        readout.textContent = `REP #${this.currentShots.length + 1}/5 — ลั่นไกใน 2.50s!`;
        readout.style.color = '#facc15';
      }
    }
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
  // BREATH HOLD (Strictly 3.0 Seconds Max + 5% Steadier Aim)
  // ===========================================================================

  public setBreathHold(active: boolean) {
    if (active) {
      this.isHoldingBreath = true;
      this.currentBreathHoldSec = 0;
      const breathBtn = document.getElementById('btn-breath-hold');
      const breathStatus = document.getElementById('breath-status-text');
      breathBtn?.classList.add('active');
      if (breathStatus) {
        breathStatus.textContent = 'ON (3.0s)';
        breathStatus.style.color = '#06b6d4';
      }
    } else {
      this.isHoldingBreath = false;
      this.currentBreathHoldSec = 0;
      const breathBtn = document.getElementById('btn-breath-hold');
      const breathSub = document.getElementById('breath-timer-sub');
      const breathStatus = document.getElementById('breath-status-text');
      breathBtn?.classList.remove('active');
      if (breathSub) breathSub.textContent = '(3.0s | +5% นิ่ง)';
      if (breathStatus) {
        breathStatus.textContent = 'OFF (3.0s)';
        breathStatus.style.color = '#94a3b8';
      }
    }
  }

  public toggleBreathHold() {
    this.setBreathHold(!this.isHoldingBreath);
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
        this.entryBpm = val;
        this.currentBpm = val;
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

    // 5. Sound Toggle (Navbar)
    document.getElementById('btn-sound-toggle')?.addEventListener('click', () => {
      this.toggleMute();
    });

    // 6. Enter Range Button
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
  // RANGE HUD CONTROLS
  // ===========================================================================

  private bindRangeControls() {
    // Exit Range
    document.getElementById('btn-range-exit')?.addEventListener('click', () => {
      this.isStationActive = false;
      cancelAnimationFrame(this.animFrameId);
      this.switchScreen('view-setup');
    });

    // Sound Toggle in Range HUD
    document.getElementById('btn-range-sound')?.addEventListener('click', () => {
      this.toggleMute();
    });

    // Recenter
    document.getElementById('btn-recenter-aim')?.addEventListener('click', () => {
      this.recenterAim();
    });

    // Breath Hold (Max 3s)
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

    // Fire Button
    const fireBtn = document.getElementById('btn-fire');
    fireBtn?.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.isPistolCocked) {
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

    // Canvas Tap & Drag
    this.rangeCanvas.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      this.lastDragX = e.clientX;
      this.lastDragY = e.clientY;

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

    // Fail Modal Buttons (Mode 2)
    document.getElementById('btn-fail-retry')?.addEventListener('click', () => {
      const modal = document.getElementById('range-fail-modal');
      if (modal) modal.style.display = 'none';
      this.startRangeSession();
    });

    document.getElementById('btn-fail-lobby')?.addEventListener('click', () => {
      const modal = document.getElementById('range-fail-modal');
      if (modal) modal.style.display = 'none';
      this.switchScreen('view-setup');
    });

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
    const modal = document.getElementById('range-fail-modal');
    if (modal) modal.style.display = 'none';

    this.isStationActive = true;
    this.isPistolCocked = true;
    this.stationStartPerfMs = performance.now();
    this.repStartPerfMs = this.stationStartPerfMs;
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
      this.maxDurationSec = 60.0; // Per-shot strict timer is 2.50s
    } else if (this.drillMode === 'SCATT_10SHOT_DIAG') {
      this.requiredHits = 10;
      this.maxShotsInDrill = 10;
      this.maxDurationSec = 180.0;
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
      if (this.drillMode === 'FIRST_SHOT_DRILL') {
        readout.textContent = 'REP #1/5 — ลั่นไกใน 2.50s!';
        readout.style.color = '#facc15';
      } else {
        readout.textContent = 'READY — ARMED';
        readout.style.color = '#38bdf8';
      }
    }

    this.lastFrameMs = performance.now();
    cancelAnimationFrame(this.animFrameId);
    this.animFrameId = requestAnimationFrame((t) => this.loopRange(t));
  }

  // Strict 2.50s Failure in Mode 2
  private triggerMode2TimeoutFail() {
    this.isStationActive = false;
    cancelAnimationFrame(this.animFrameId);
    sfx.playJerk();
    const modal = document.getElementById('range-fail-modal');
    const desc = document.getElementById('fail-modal-desc');
    if (desc) {
      desc.textContent = `ในโหมด First-Shot Speed (นัดที่ ${this.currentShots.length + 1}/5) คุณลั่นไกช้าเกิน 2.50 วินาที ระบบจึงหยุดการฝึกซ้อมทันที`;
    }
    if (modal) modal.style.display = 'flex';
  }

  // ===========================================================================
  // TRIGGER ACTIONS & SHOT BREAK
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
      this.drillMode === 'FIRST_SHOT_DRILL'
        ? (nowPerf - this.repStartPerfMs) / 1000.0
        : (this.currentShots.length === 0 ? timeSinceStartSec : (nowPerf - this.lastShotPerfMs) / 1000.0);
    const holdSec = (nowPerf - this.lastRaiseFromTableMs) / 1000.0;

    this.lastShotPerfMs = nowPerf;

    // Shot Sound + Short Female Breath Vocal Effect "Ah!"
    sfx.playShot();
    sfx.playFemaleVoiceAh();
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
      bpmSource: 'SIMULATED_MODEL',
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

    // Check Drill Completion
    if (this.drillMode === 'FIRST_SHOT_DRILL') {
      if (this.currentShots.length >= 5) {
        sfx.playSeriesCleared();
        this.completeSeries(false);
      } else {
        if (readout) {
          readout.textContent = `นัดที่ #${this.currentShots.length} สำเร็จ (${p.splitSec.toFixed(2)}s) — สับไกปืนเพื่อนัดถัดไป!`;
          readout.style.color = '#38bdf8';
        }
      }
      return;
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

    // Timer Logic: Mode 2 (Strict 2.50s countdown) vs General Timer
    const timerEl = document.getElementById('range-countdown-val');
    if (this.drillMode === 'FIRST_SHOT_DRILL') {
      if (this.isPistolCocked) {
        const repElapsedSec = (nowMs - this.repStartPerfMs) / 1000.0;
        const repRemainingSec = Math.max(0, 2.50 - repElapsedSec);
        if (timerEl) {
          timerEl.innerHTML = `${repRemainingSec.toFixed(2)}<span>s</span>`;
          timerEl.style.color = repRemainingSec <= 0.8 ? '#ef4444' : '#facc15';
        }

        // If exceeded 2.50s, STOP THE GAME IMMEDIATELY!
        if (repRemainingSec <= 0 && !this.pendingFollowThroughShot) {
          this.triggerMode2TimeoutFail();
          return;
        }
      } else {
        if (timerEl) {
          timerEl.innerHTML = `2.50<span>s</span>`;
          timerEl.style.color = '#94a3b8';
        }
      }
    } else {
      let elapsedSec = (nowMs - this.stationStartPerfMs) / 1000.0;
      const remainingSec = Math.max(0, this.maxDurationSec - elapsedSec);
      if (timerEl) {
        timerEl.innerHTML = `${remainingSec.toFixed(1)}<span>s</span>`;
        timerEl.style.color = remainingSec <= 10.0 ? '#ef4444' : '#ffffff';
      }

      if (remainingSec <= 0) {
        this.completeSeries(true);
        return;
      }
    }

    // Mode 4 Cadence Metronome (Loud & Crisp Tick)
    let elapsedForMetronome = (nowMs - this.stationStartPerfMs) / 1000.0;
    if (this.drillMode === 'CADENCE_METRONOME' && elapsedForMetronome >= this.nextMetronomeTickSec) {
      sfx.playMetronomeTick();
      this.nextMetronomeTickSec += this.cadenceIntervalSec;
    }

    // Breath-Hold Max 3.0s Auto-Release
    if (this.isHoldingBreath) {
      this.currentBreathHoldSec += dtSec;
      const remainingHoldSec = Math.max(0, 3.0 - this.currentBreathHoldSec);
      const breathSub = document.getElementById('breath-timer-sub');
      const breathStatus = document.getElementById('breath-status-text');
      if (breathSub) breathSub.textContent = `(${remainingHoldSec.toFixed(1)}s | +5% นิ่ง)`;
      if (breathStatus) breathStatus.textContent = `ON (${remainingHoldSec.toFixed(1)}s)`;

      if (this.currentBreathHoldSec >= 3.0) {
        this.setBreathHold(false);
      }
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

    // FUSE ORIENTATION SENSORS + DRAG + 5% STEADIER AIM ON BREATH HOLD
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

    // Breath Hold: 5% dampening on jitter and aim deviation
    const breathDamping = this.isHoldingBreath ? 0.95 : 1.0;
    const swayDamping = this.isHoldingBreath ? 0.65 : 1.0;

    targetYawDeg *= breathDamping;
    targetPitchDeg *= breathDamping;

    const totalYaw = this.yawFilter.filter(targetYawDeg + phys.swayYawDeg * swayDamping, dtSec);
    const totalPitch = this.pitchFilter.filter(targetPitchDeg + phys.swayPitchDeg * swayDamping, dtSec);
    this.currentCantDeg = this.rollFilter.filter(targetRollDeg, dtSec);
    this.currentFrontSightShiftMm = phys.frontSightPulseMm * (this.isHoldingBreath ? 0.75 : 1.0);

    const coords = this.targetGeo.anglesToTargetMm(
      totalYaw,
      totalPitch,
      this.currentCantDeg,
      this.currentFrontSightShiftMm
    );
    this.currentXMm = coords.xMm * breathDamping;
    this.currentYMm = coords.yMm * breathDamping;
    this.currentRadialMm = coords.radialErrorMm * breathDamping;

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

    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, w, h);

    const boxHalfPx = 80.0 * pxPerMm;
    ctx.fillStyle = '#e2dcc8';
    ctx.beginPath();
    ctx.roundRect(cx - boxHalfPx, cy - boxHalfPx, boxHalfPx * 2, boxHalfPx * 2, 10);
    ctx.fill();

    const blackRadiusPx = 29.75 * pxPerMm;
    ctx.fillStyle = '#090b10';
    ctx.beginPath();
    ctx.arc(cx, cy, blackRadiusPx, 0, Math.PI * 2);
    ctx.fill();

    for (let ring = 1; ring <= 11; ring++) {
      const rPx = this.targetGeo.getRingRadiusMm(ring) * pxPerMm;
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      ctx.strokeStyle = ring === 7 ? '#22c55e' : (ring <= 6 ? 'rgba(15, 23, 42, 0.4)' : 'rgba(255, 255, 255, 0.3)');
      ctx.lineWidth = ring === 7 ? 1.6 : 1;
      ctx.stroke();
    }

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
  // RESULTS & DEEP SCATT SHOT-BY-SHOT TELEMETRY
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
      'SIMULATED_MODEL',
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
      if (this.drillMode === 'FIRST_SHOT_DRILL') {
        const avgSplit = (series.shots.reduce((a, b) => a + b.splitFromPrevShotSec, 0) / Math.max(1, series.shots.length)).toFixed(2);
        titleEl.textContent = `⚡ FIRST-SHOT DRILL COMPLETE — AVG: ${avgSplit}s`;
      } else {
        titleEl.textContent = series.isTimedOut
          ? `⏱️ หมดเวลา (${series.hitsCleared}/${this.requiredHits} HITS)`
          : `✅ SERIES COMPLETE — ${series.totalRangeStationDurationSec.toFixed(2)}s`;
      }
    }

    const summaryTable = document.getElementById('table-result-metrics');
    if (summaryTable) {
      summaryTable.innerHTML = `
        <tr>
          <td>เวลาชุดยิงรวม (Station Time)</td>
          <td><strong>${series.totalRangeStationDurationSec.toFixed(2)}s</strong> (ยิงนัดแรก: <strong>${series.firstShotDurationSec.toFixed(2)}s</strong>)</td>
        </tr>
        <tr>
          <td>จำนวนเข้าเป้า (Hits Cleared)</td>
          <td><strong>${series.hitsCleared} / ${series.totalShotsFired}</strong> (${series.accuracyPct}%)</td>
        </tr>
        <tr>
          <td>คะแนนทศนิยมเฉลี่ย (ISSF Decimal Score)</td>
          <td><strong style="color:#2563eb;">${series.avgDecimalScore.toFixed(1)}</strong> / 10.9</td>
        </tr>
        <tr>
          <td>ความเร็วปากกระบอก SCATT (Trace Speed L)</td>
          <td><strong>${series.avgTraceLengthMmPerSec.toFixed(1)} mm/s</strong> (เป้าหมายโปร &lt; 95 mm/s)</td>
        </tr>
        <tr>
          <td>ความนิ่งในวงดำ 59.5mm (Stability 7-Ring)</td>
          <td><strong>${series.avgStability7RingPct}%</strong></td>
        </tr>
        <tr>
          <td>ระยะกระตุกไกเฉลี่ย (Mean Pull Error)</td>
          <td><strong>${series.avgPullErrorMm.toFixed(1)} mm</strong></td>
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
        pill.textContent = `#${s.shotIndex}: ${s.scatt.decimalScore.toFixed(1)} (${s.scatt.clockDirection}h)`;
        pill.addEventListener('click', () => {
          this.selectedReplayShotIdx = idx;
          this.refreshReplay(series);
        });
        pillsRow.appendChild(pill);

        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => {
          this.selectedReplayShotIdx = idx;
          this.refreshReplay(series);
        });
        tr.innerHTML = `
          <td>#${s.shotIndex}</td>
          <td style="color:${s.isHit ? '#16a34a' : '#dc2626'}; font-weight:800;">
            ${s.scatt.decimalScore.toFixed(1)} (${s.scatt.clockDirection}h)
          </td>
          <td>${s.splitFromPrevShotSec.toFixed(2)}s</td>
          <td>${s.scatt.traceLengthMmPerSec}</td>
          <td>${s.scatt.stability7RingPct}%</td>
          <td>${s.jerk.isJerk ? `⚠️ ${s.jerk.flinchDirection}` : 'CLEAN'}</td>
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

  // Deep Shot-by-Shot Telemetry Breakdown
  private refreshReplay(series: SeriesResult) {
    const pills = document.querySelectorAll('#scatt-shot-pills .shot-pill');
    pills.forEach((p, idx) => {
      p.classList.toggle('active', idx - 1 === this.selectedReplayShotIdx);
    });

    const detailBox = document.getElementById('scatt-selected-shot-detail');
    if (detailBox) {
      if (this.selectedReplayShotIdx >= 0 && series.shots[this.selectedReplayShotIdx]) {
        const s = series.shots[this.selectedReplayShotIdx];
        const statusHit = s.isHit ? '🟢 เข้าเป้า (HIT)' : '🔴 หลุดเป้า (MISS)';
        detailBox.innerHTML = `
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:6px; margin-bottom:6px;">
            <div><strong>นัดที่:</strong> #${s.shotIndex} ${statusHit}</div>
            <div><strong>คะแนนทศนิยม:</strong> ${s.scatt.decimalScore.toFixed(1)} / 10.9</div>
            <div><strong>ทิศทางหน้าปัด:</strong> ${s.scatt.clockDirection} นาฬิกา</div>
            <div><strong>ระยะห่างจุดศูนย์กลาง:</strong> ${s.radialErrorMm.toFixed(1)} mm</div>
            <div><strong>SCATT Trace Speed (L):</strong> ${s.scatt.traceLengthMmPerSec} mm/s</div>
            <div><strong>ความนิ่งในวงดำ (7-Ring):</strong> ${s.scatt.stability7RingPct}%</div>
            <div><strong>ความนิ่งในวง 10:</strong> ${s.scatt.stability10RingPct}%</div>
            <div><strong>ระยะกระตุกไก (Pull Err):</strong> ${s.scatt.pullErrorMm} mm @ ${s.scatt.pullDirectionClock}h</div>
            <div><strong>องศาเอียงปืน (Cant):</strong> ${s.scatt.cantAngleAtShotDeg}°</div>
            <div><strong>เวลาลั่นไก (Split):</strong> ${s.splitFromPrevShotSec.toFixed(2)}s</div>
          </div>
          <div style="font-size:11px; color:#475569; border-top:1px dashed #cbd5e1; padding-top:4px;">
            💡 <strong>การวินิจฉัยชีวกลศาสตร์:</strong> ${
              s.jerk.isJerk
                ? `ตรวจพบการสะบัดข้อมือ/กระตุกไก (${s.jerk.flinchDirection}) ระยะคลาดเคลื่อน ${s.scatt.pullErrorMm}mm แนะนำบีบไกนุ่มนวลและไม่กระตุกปลายนิ้วชี้`
                : s.scatt.traceLengthMmPerSec <= 95
                ? 'ความนิ่งของข้อมือและหัวไหล่ยอดเยี่ยมระดับนักกีฬาทีมชาติ ศูนย์เล็งนิ่งสนิท'
                : 'ศูนย์เล็งยังแกว่งตัวค่อนข้างเร็วขณะลั่นไก แนะนำใช้ปุ่มกลั้นหายใจเพื่อลดแรงกระเพื่อมอก'
            }
          </div>
        `;
      } else {
        detailBox.innerHTML = `ภาพรวมทั้งชุด (${series.totalShotsFired} นัด) — แตะหมายเลขด้านบน (#1, #2, ...) เพื่อวิเคราะห์เจาะลึกวิถีศูนย์เล็งและชีวกลศาสตร์ทีละนัด`;
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
