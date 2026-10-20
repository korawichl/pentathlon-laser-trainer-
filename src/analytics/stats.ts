import { DrillMode, SeriesResult, ShotRecord } from '../types';
import { RuleBasedCoach } from './coach';

export class PerformanceAnalytics {
  /**
   * Computes full SCATT & UIPM ballistic grouping and stability metrics for a series.
   */
  public static computeSeriesMetrics(
    roundIndex: number,
    runDurationSec: number,
    transitionDurationSec: number,
    firstShotDurationSec: number,
    totalRangeStationDurationSec: number,
    shots: ShotRecord[],
    heartRateEnterBpm: number,
    heartRateExitBpm: number,
    hrSource: SeriesResult['hrSource'],
    drillMode: DrillMode = 'UIPM_5HIT_SERIES'
  ): SeriesResult {
    const hitsCleared = shots.filter(s => s.isHit).length;
    const isTimedOut = totalRangeStationDurationSec >= 50.0 && hitsCleared < 5;
    const totalShotsFired = shots.length;
    const accuracyPct = totalShotsFired > 0 ? (hitsCleared / totalShotsFired) * 100 : 0;
    const pureShootingDurationSec = Math.max(0, totalRangeStationDurationSec - firstShotDurationSec);

    if (totalShotsFired === 0) {
      return {
        seriesId: `SER_${Date.now()}`,
        dateIso: new Date().toISOString(),
        drillMode,
        roundIndex,
        runDurationSec,
        transitionDurationSec,
        firstShotDurationSec,
        pureShootingDurationSec,
        totalRangeStationDurationSec,
        totalShotsFired: 0,
        hitsCleared: 0,
        isTimedOut,
        accuracyPct: 0,
        avgDecimalScore: 0,
        avgTraceLengthMmPerSec: 0,
        avgStability7RingPct: 0,
        avgPullErrorMm: 0,
        meanPointOfImpactMm: { x: 0, y: 0 },
        meanRadialErrorMm: 0,
        horizontalDispersionMm: 0,
        verticalDispersionMm: 0,
        extremeSpreadMm: 0,
        shots: [],
        heartRateEnterBpm,
        heartRateExitBpm,
        hrSource,
        coachDiagnostics: ['ไม่มีข้อมูลกระสุนในชุดยิงนี้']
      };
    }

    let sumX = 0;
    let sumY = 0;
    let sumDecScore = 0;
    let sumTraceLen = 0;
    let sumStab7 = 0;
    let sumPullErr = 0;

    for (const s of shots) {
      sumX += s.offsetMmX;
      sumY += s.offsetMmY;
      sumDecScore += s.scatt.decimalScore;
      sumTraceLen += s.scatt.traceLengthMmPerSec;
      sumStab7 += s.scatt.stability7RingPct;
      sumPullErr += s.scatt.pullErrorMm;
    }

    const mpiX = sumX / totalShotsFired;
    const mpiY = sumY / totalShotsFired;
    const avgDecimalScore = sumDecScore / totalShotsFired;
    const avgTraceLengthMmPerSec = sumTraceLen / totalShotsFired;
    const avgStability7RingPct = sumStab7 / totalShotsFired;
    const avgPullErrorMm = sumPullErr / totalShotsFired;

    let sumRadial = 0;
    let sumDevXSq = 0;
    let sumDevYSq = 0;
    for (const s of shots) {
      sumRadial += s.radialErrorMm;
      const dx = s.offsetMmX - mpiX;
      const dy = s.offsetMmY - mpiY;
      sumDevXSq += dx * dx;
      sumDevYSq += dy * dy;
    }
    const meanRadialErrorMm = sumRadial / totalShotsFired;
    const horizontalDispersionMm = Math.sqrt(sumDevXSq / totalShotsFired);
    const verticalDispersionMm = Math.sqrt(sumDevYSq / totalShotsFired);

    let extremeSpreadMm = 0;
    for (let i = 0; i < totalShotsFired; i++) {
      for (let j = i + 1; j < totalShotsFired; j++) {
        const dx = shots[i].offsetMmX - shots[j].offsetMmX;
        const dy = shots[i].offsetMmY - shots[j].offsetMmY;
        const dist = Math.hypot(dx, dy);
        if (dist > extremeSpreadMm) extremeSpreadMm = dist;
      }
    }

    const result: SeriesResult = {
      seriesId: `SER_${Date.now()}`,
      dateIso: new Date().toISOString(),
      drillMode,
      roundIndex,
      runDurationSec: parseFloat(runDurationSec.toFixed(1)),
      transitionDurationSec: parseFloat(transitionDurationSec.toFixed(2)),
      firstShotDurationSec: parseFloat(firstShotDurationSec.toFixed(2)),
      pureShootingDurationSec: parseFloat(pureShootingDurationSec.toFixed(2)),
      totalRangeStationDurationSec: parseFloat(totalRangeStationDurationSec.toFixed(2)),
      totalShotsFired,
      hitsCleared,
      isTimedOut,
      accuracyPct: parseFloat(accuracyPct.toFixed(1)),
      avgDecimalScore: parseFloat(avgDecimalScore.toFixed(1)),
      avgTraceLengthMmPerSec: parseFloat(avgTraceLengthMmPerSec.toFixed(1)),
      avgStability7RingPct: Math.round(avgStability7RingPct),
      avgPullErrorMm: parseFloat(avgPullErrorMm.toFixed(1)),
      meanPointOfImpactMm: { x: parseFloat(mpiX.toFixed(1)), y: parseFloat(mpiY.toFixed(1)) },
      meanRadialErrorMm: parseFloat(meanRadialErrorMm.toFixed(1)),
      horizontalDispersionMm: parseFloat(horizontalDispersionMm.toFixed(1)),
      verticalDispersionMm: parseFloat(verticalDispersionMm.toFixed(1)),
      extremeSpreadMm: parseFloat(extremeSpreadMm.toFixed(1)),
      shots,
      heartRateEnterBpm,
      heartRateExitBpm,
      hrSource,
      coachDiagnostics: []
    };

    result.coachDiagnostics = RuleBasedCoach.diagnoseSeries(result);
    return result;
  }
}
