import { JerkAnalysis, MotionSample, ScattShotMetrics, TracePoint } from '../types';
import { TargetGeometry } from '../ballistics/target';

export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xPrev: number = 0;
  private dxPrev: number = 0;
  private initialized: boolean = false;

  constructor(minCutoff = 4.5, beta = 0.04, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  private alpha(cutoff: number, dt: number): number {
    const tau = 1.0 / (2.0 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / Math.max(dt, 0.001));
  }

  public filter(x: number, dt: number): number {
    if (!this.initialized || dt <= 0) {
      this.initialized = true;
      this.xPrev = x;
      this.dxPrev = 0;
      return x;
    }
    const dx = (x - this.xPrev) / dt;
    const edx = this.dxPrev + this.alpha(this.dCutoff, dt) * (dx - this.dxPrev);
    this.dxPrev = edx;
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const filtered = this.xPrev + this.alpha(cutoff, dt) * (x - this.xPrev);
    this.xPrev = filtered;
    return filtered;
  }

  public reset() {
    this.initialized = false;
  }
}

export class MotionBiomechanics {
  private motionBuffer: MotionSample[] = [];
  private readonly bufferDurationMs = 2000; // Keep 2.0 seconds of high-rate telemetry

  // Physiological state
  private clockSec = 0;
  private beatPhaseSec = 0;
  private breathPhaseRad = 0;
  private breathGate = 1.0;
  public currentBreathHoldSec = 0;
  public deltoidHoldSec = 0; // Accumulates while arm is raised

  public pushSample(sample: MotionSample) {
    this.motionBuffer.push(sample);
    const cutoff = sample.timestampMs - this.bufferDurationMs;
    while (this.motionBuffer.length > 0 && this.motionBuffer[0].timestampMs < cutoff) {
      this.motionBuffer.shift();
    }
  }

  public resetDeltoidFatigue() {
    this.deltoidHoldSec = Math.max(0, this.deltoidHoldSec * 0.25); // Lowering arm to table relieves 75% of deltoid buildup
  }

  /**
   * Computes realistic physiological perturbations (in degrees & sight shift mm):
   * 1. Respiratory chest heave (suppressed during breath hold)
   * 2. Ballistocardiogram systolic pulse wave (sharp radial artery pulse at each heartbeat)
   * 3. Hypoxic 8-12Hz muscle tremor if breath held past safe oxygen window
   * 4. Isometric deltoid shoulder tremor when holding arm extended > 10s
   */
  public stepPhysiology(
    dtSec: number,
    bpm: number,
    isHoldingBreath: boolean,
    isArmRaised: boolean
  ): {
    swayYawDeg: number;
    swayPitchDeg: number;
    frontSightPulseMm: number;
    isSystolicPeak: boolean;
    hypoxicStress01: number;
    deltoidFatiguePct: number;
  } {
    this.clockSec += dtSec;
    const fatigue01 = Math.max(0.05, Math.min(1.0, (bpm - 60) / 130));

    // 1. Breath Hold & Hypoxia Window
    const safeApneaSec = Math.max(3.2, 7.5 * (1.0 - 0.52 * fatigue01));
    if (isHoldingBreath) {
      this.currentBreathHoldSec += dtSec;
      this.breathGate = Math.max(0.06, this.breathGate - dtSec * 3.0);
    } else {
      this.currentBreathHoldSec = Math.max(0, this.currentBreathHoldSec - dtSec * 2.5);
      this.breathGate = Math.min(1.0, this.breathGate + dtSec * 2.5);
    }
    const oxygenDebtSec = Math.max(0, this.currentBreathHoldSec - safeApneaSec);
    const hypoxicStress01 = Math.min(1.0, oxygenDebtSec / 3.0);

    // 2. Isometric Deltoid Fatigue (holding ~950g pistol extended)
    if (isArmRaised) {
      this.deltoidHoldSec += dtSec;
    } else {
      this.deltoidHoldSec = Math.max(0, this.deltoidHoldSec - dtSec * 2.2);
    }
    const deltoidFatiguePct = Math.min(100, Math.max(0, ((this.deltoidHoldSec - 4.0) / 22.0) * 100));
    const deltoid01 = deltoidFatiguePct / 100.0;

    // 3. Respiratory Cycle (14 to 42 breaths/min)
    const respRatePerMin = 14 + fatigue01 * 28;
    this.breathPhaseRad += 2.0 * Math.PI * (respRatePerMin / 60.0) * dtSec;
    const breathPitchDeg = Math.sin(this.breathPhaseRad) * (0.06 + 0.24 * fatigue01) * this.breathGate;
    const breathYawDeg = Math.cos(this.breathPhaseRad * 0.5) * (0.02 + 0.07 * fatigue01) * this.breathGate;

    // 4. Systolic Heartbeat Pulse Wave (Ballistocardiogram)
    const beatPeriodSec = 60.0 / Math.max(45, bpm);
    this.beatPhaseSec = (this.beatPhaseSec + dtSec) % beatPeriodSec;
    // Sharp systolic spike around t = 0.07s of cardiac cycle, followed by dicrotic notch
    const z1 = (this.beatPhaseSec - 0.065) / 0.028;
    const z2 = (this.beatPhaseSec - 0.16) / 0.045;
    const pulseWave = Math.exp(-z1 * z1) - 0.35 * Math.exp(-z2 * z2);
    const isSystolicPeak = Math.abs(this.beatPhaseSec - 0.065) < 0.03;

    const pulsePitchDeg = pulseWave * (0.018 + 0.075 * fatigue01);
    const pulseYawDeg = pulseWave * (0.01 + 0.035 * fatigue01);
    const frontSightPulseMm = pulseWave * (0.04 + 0.16 * fatigue01);

    // 5. High-frequency Neuromuscular Tremor (8–12 Hz physiological tremor)
    const tremorAmp = 0.012 + 0.035 * fatigue01 + 0.11 * hypoxicStress01 + 0.09 * deltoid01;
    const t = this.clockSec;
    const tremorX =
      (Math.sin(t * 53.4) * 0.5 + Math.sin(t * 67.8 + 1.2) * 0.35 + Math.cos(t * 29.1) * 0.15) * tremorAmp;
    const tremorY =
      (Math.cos(t * 58.1) * 0.5 + Math.sin(t * 73.2 + 2.4) * 0.35 + Math.sin(t * 31.7) * 0.15) * tremorAmp;

    return {
      swayYawDeg: breathYawDeg + pulseYawDeg + tremorX,
      swayPitchDeg: breathPitchDeg + pulsePitchDeg + tremorY,
      frontSightPulseMm,
      isSystolicPeak,
      hypoxicStress01,
      deltoidFatiguePct: Math.round(deltoidFatiguePct)
    };
  }

  /**
   * Analyzes trigger stability & jerk across [-400ms, +60ms]
   */
  public analyzeTriggerJerk(triggerTimeMs: number): JerkAnalysis {
    if (this.motionBuffer.length < 5) {
      return {
        isJerk: false,
        preTriggerStabilityRms: 0,
        triggerSpikePeak: 0,
        jerkRatio: 1.0,
        flinchDirection: 'NONE'
      };
    }

    let holdAccelSqSum = 0;
    let holdCount = 0;
    let peakSpike = 0;
    let netDeltaPitch = 0;
    let netDeltaYaw = 0;

    for (let i = 1; i < this.motionBuffer.length; i++) {
      const s = this.motionBuffer[i];
      const prev = this.motionBuffer[i - 1];
      const relTime = s.timestampMs - triggerTimeMs;

      const dt = Math.max((s.timestampMs - prev.timestampMs) / 1000.0, 0.004);
      const dAx = (s.accelX - prev.accelX) / dt;
      const dAy = (s.accelY - prev.accelY) / dt;
      const dAz = (s.accelZ - prev.accelZ) / dt;
      const jerkMag = Math.sqrt(dAx * dAx + dAy * dAy + dAz * dAz);

      // Angular velocity contribution (deg/s)
      const angVel = Math.hypot(s.yawDeg - prev.yawDeg, s.pitchDeg - prev.pitchDeg) / dt;
      const combinedJerk = jerkMag + angVel * 2.8;

      if (relTime >= -400 && relTime <= -150) {
        holdAccelSqSum += combinedJerk * combinedJerk;
        holdCount++;
      }

      if (relTime >= -85 && relTime <= 45) {
        if (combinedJerk > peakSpike) {
          peakSpike = combinedJerk;
        }
        netDeltaPitch += s.pitchDeg - prev.pitchDeg;
        netDeltaYaw += s.yawDeg - prev.yawDeg;
      }
    }

    const holdRms = holdCount > 0 ? Math.sqrt(holdAccelSqSum / holdCount) : 1.2;
    const jerkRatio = peakSpike / Math.max(holdRms, 0.8);
    const isJerk = jerkRatio >= 2.35 || peakSpike >= 22.0;

    let flinchDirection: JerkAnalysis['flinchDirection'] = 'NONE';
    if (isJerk) {
      if (netDeltaPitch < -0.06 && netDeltaYaw < -0.04) {
        flinchDirection = 'LOW_LEFT'; // Classic right-handed trigger squeeze pull + wrist drop
      } else if (netDeltaPitch < -0.06 && netDeltaYaw > 0.04) {
        flinchDirection = 'LOW_RIGHT';
      } else if (netDeltaPitch < -0.05) {
        flinchDirection = 'LOW_DOWN'; // Heel anticipation / pushing muzzle down
      } else if (netDeltaPitch > 0.06) {
        flinchDirection = 'HIGH_UP';
      } else if (netDeltaYaw > 0.05) {
        flinchDirection = 'LATERAL_RIGHT';
      } else if (netDeltaYaw < -0.05) {
        flinchDirection = 'LATERAL_LEFT';
      }
    }

    return {
      isJerk,
      preTriggerStabilityRms: parseFloat(holdRms.toFixed(2)),
      triggerSpikePeak: parseFloat(peakSpike.toFixed(2)),
      jerkRatio: parseFloat(jerkRatio.toFixed(2)),
      flinchDirection
    };
  }

  /**
   * Computes complete SCATT Optical Trace (-1000ms to +200ms) and SCATT metrics for a shot.
   */
  public computeScattMetricsAndTrace(
    shotTimeMs: number,
    shotXMm: number,
    shotYMm: number,
    cantAtShotDeg: number,
    holdDurationSec: number,
    target: TargetGeometry
  ): { scatt: ScattShotMetrics; trace: TracePoint[] } {
    const trace: TracePoint[] = [];
    let pathLengthMm = 0;
    let totalDurationPreSec = 0;
    let in7Count = 0;
    let in10Count = 0;
    let preCount = 0;

    let holdMeanX = 0;
    let holdMeanY = 0;
    let holdWindowCount = 0;

    let prevPt: TracePoint | null = null;

    for (const s of this.motionBuffer) {
      const tRel = s.timestampMs - shotTimeMs;
      if (tRel < -1000 || tRel > 250) continue;
      if (s.xMm === undefined || s.yMm === undefined) continue;

      const pt: TracePoint = {
        tRelMs: Math.round(tRel),
        xMm: parseFloat(s.xMm.toFixed(1)),
        yMm: parseFloat(s.yMm.toFixed(1)),
        cantDeg: parseFloat(s.rollDeg.toFixed(1)),
        frontSightShiftMm: parseFloat((s.frontSightShiftMm || 0).toFixed(2))
      };
      trace.push(pt);

      if (tRel <= 0) {
        preCount++;
        const r = Math.hypot(pt.xMm, pt.yMm);
        if (r <= 29.75) in7Count++;
        if (r <= 5.75) in10Count++;

        if (prevPt && prevPt.tRelMs <= 0) {
          const segDist = Math.hypot(pt.xMm - prevPt.xMm, pt.yMm - prevPt.yMm);
          const segDt = (pt.tRelMs - prevPt.tRelMs) / 1000.0;
          if (segDt > 0) {
            pathLengthMm += segDist;
            totalDurationPreSec += segDt;
          }
        }

        // Mean hold center between -350ms and -80ms before trigger break
        if (tRel >= -350 && tRel <= -80) {
          holdMeanX += pt.xMm;
          holdMeanY += pt.yMm;
          holdWindowCount++;
        }
      }
      prevPt = pt;
    }

    const traceLengthMmPerSec = totalDurationPreSec > 0.1 ? pathLengthMm / totalDurationPreSec : 85.0;
    const stability7RingPct = preCount > 0 ? Math.round((in7Count / preCount) * 100) : 0;
    const stability10RingPct = preCount > 0 ? Math.round((in10Count / preCount) * 100) : 0;

    let pullErrorMm = 0;
    let pullDirectionClock = 12;
    if (holdWindowCount > 0) {
      const avgHoldX = holdMeanX / holdWindowCount;
      const avgHoldY = holdMeanY / holdWindowCount;
      const dx = shotXMm - avgHoldX;
      const dy = shotYMm - avgHoldY;
      pullErrorMm = Math.hypot(dx, dy);
      pullDirectionClock = target.computeClockDirection(dx, dy);
    }

    const radialErr = Math.hypot(shotXMm, shotYMm);
    const decimalScore = target.computeDecimalScore(radialErr);
    const clockDirection = target.computeClockDirection(shotXMm, shotYMm);

    // Follow-through drift (points with tRel > 0)
    const postPts = trace.filter(p => p.tRelMs > 20);
    let followDrift = 0;
    if (postPts.length > 0) {
      const lastPost = postPts[postPts.length - 1];
      followDrift = Math.hypot(lastPost.xMm - shotXMm, lastPost.yMm - shotYMm);
    }

    return {
      scatt: {
        decimalScore,
        clockDirection,
        traceLengthMmPerSec: parseFloat(traceLengthMmPerSec.toFixed(1)),
        stability7RingPct,
        stability10RingPct,
        pullErrorMm: parseFloat(pullErrorMm.toFixed(1)),
        pullDirectionClock,
        followThroughDriftMm: parseFloat(followDrift.toFixed(1)),
        cantAngleAtShotDeg: parseFloat(cantAtShotDeg.toFixed(1)),
        holdDurationSec: parseFloat(holdDurationSec.toFixed(2))
      },
      trace
    };
  }
}
