import { CompleteSessionData, SeriesResult } from '../types';

export class SessionStorageExport {
  private static readonly STORAGE_KEY = 'PENTATHLON_SCATT_SERIES_HISTORY_V2';

  public static saveSeries(series: SeriesResult) {
    try {
      const existing = this.getAllSeries();
      existing.unshift(series);
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(existing.slice(0, 60)));
    } catch (err) {
      console.error('Failed to save series:', err);
    }
  }

  public static getAllSeries(): SeriesResult[] {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (!raw) return [];
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  public static saveSession(session: CompleteSessionData) {
    if (session.series.length > 0) {
      this.saveSeries(session.series[session.series.length - 1]);
    }
  }

  /**
   * Exports full SCATT & UIPM Biomechanics Shot-by-Shot CSV
   */
  public static exportSeriesToCsv(series: SeriesResult): void {
    const headers = [
      'SeriesId',
      'DateIso',
      'DrillMode',
      'ShotIndex',
      'TimeSinceStart_s',
      'Split_s',
      'Hit_7Ring',
      'DecimalScore',
      'ClockDir',
      'OffsetX_mm',
      'OffsetY_mm',
      'RadialError_mm',
      'SCATT_TraceSpeed_mm_s',
      'SCATT_Stability7Ring_Pct',
      'SCATT_Stability10Ring_Pct',
      'TriggerPullError_mm',
      'CantAngle_deg',
      'FollowThroughDrift_mm',
      'HeartRate_BPM',
      'BreathHeld',
      'DeltoidFatigue_Pct',
      'IsJerk',
      'JerkRatio',
      'FlinchDirection'
    ];

    const rows: string[] = [headers.join(',')];

    for (const s of series.shots) {
      const row = [
        series.seriesId,
        series.dateIso,
        series.drillMode,
        s.shotIndex,
        s.timeSinceSeriesStartSec.toFixed(2),
        s.splitFromPrevShotSec.toFixed(2),
        s.isHit ? 1 : 0,
        s.scatt.decimalScore.toFixed(1),
        s.scatt.clockDirection,
        s.offsetMmX.toFixed(1),
        s.offsetMmY.toFixed(1),
        s.radialErrorMm.toFixed(1),
        s.scatt.traceLengthMmPerSec.toFixed(1),
        s.scatt.stability7RingPct,
        s.scatt.stability10RingPct,
        s.scatt.pullErrorMm.toFixed(1),
        s.scatt.cantAngleAtShotDeg.toFixed(1),
        s.scatt.followThroughDriftMm.toFixed(1),
        s.currentBpm,
        s.breathHeldAtShot ? 1 : 0,
        s.deltoidFatiguePct,
        s.jerk.isJerk ? 1 : 0,
        s.jerk.jerkRatio.toFixed(2),
        s.jerk.flinchDirection
      ];
      rows.push(row.join(','));
    }

    const csvContent = rows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `SCATT_UIPM_LaserPistol_${series.drillMode}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  public static exportSessionToCsv(session: CompleteSessionData): void {
    if (session.series.length > 0) {
      this.exportSeriesToCsv(session.series[session.series.length - 1]);
    }
  }
}
