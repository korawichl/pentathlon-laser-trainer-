import {
  CompleteSessionData,
  PreSessionData,
  SeriesResult,
  ShotRecord,
  TrainingProtocol
} from '../types';
import { TargetGeometry } from '../ballistics/target';
import { HeartRateTelemetry } from '../telemetry/heartRate';
import { MotionBiomechanics } from '../sensors/motion';
import { PerformanceAnalytics } from '../analytics/stats';
import { RuleBasedCoach } from '../analytics/coach';
import { SessionStorageExport } from '../storage/export';

export class SessionEngine {
  public protocol: TrainingProtocol;
  public preAssessment: PreSessionData;
  public target: TargetGeometry;
  public heartRate: HeartRateTelemetry;
  public motion: MotionBiomechanics;
  public seriesResults: SeriesResult[] = [];

  constructor() {
    this.target = new TargetGeometry(10.0, 59.5);
    this.heartRate = new HeartRateTelemetry();
    this.motion = new MotionBiomechanics();

    this.protocol = {
      id: 'UIPM_STANDARD_5HIT',
      name: 'UIPM 10m Laser Pistol Range',
      totalRounds: 1,
      runDistanceMetersPerRound: 0,
      requiredHitsPerSeries: 5,
      maxSeriesDurationSec: 50.0,
      targetDistanceMeters: 10.0,
      targetDiameterMm: 59.5,
      allowVirtualSwayInSimulation: true
    };

    this.preAssessment = {
      athleteId: 'ATH-01',
      athleteName: 'National Pentathlete',
      dateIso: new Date().toISOString(),
      sessionType: 'TECHNICAL_DRILL',
      restingBpm: 65,
      restingBpmSource: 'MANUAL_ENTRY',
      surface: 'TRACK',
      environmentalTempC: 25,
      rpePre: 2
    };
  }

  public recordCompletedSeries(
    firstShotSec: number,
    totalStationSec: number,
    shots: ShotRecord[],
    enterBpm: number,
    exitBpm: number
  ): SeriesResult {
    const res = PerformanceAnalytics.computeSeriesMetrics(
      this.seriesResults.length + 1,
      0,
      0,
      firstShotSec,
      totalStationSec,
      shots,
      enterBpm,
      exitBpm,
      this.heartRate.getSource()
    );
    this.seriesResults.push(res);
    SessionStorageExport.saveSeries(res);
    return res;
  }

  public buildFullSession(): CompleteSessionData {
    const totalDuration = this.seriesResults.reduce((s, r) => s + r.totalRangeStationDurationSec, 0);
    const totalHits = this.seriesResults.reduce((s, r) => s + r.hitsCleared, 0);
    const totalShots = this.seriesResults.reduce((s, r) => s + r.totalShotsFired, 0);
    const acc = totalShots > 0 ? (totalHits / totalShots) * 100 : 0;

    const session: CompleteSessionData = {
      sessionId: `SES_${Date.now()}`,
      protocol: this.protocol,
      preAssessment: this.preAssessment,
      rpePost: 6,
      series: this.seriesResults,
      totalSessionDurationSec: parseFloat(totalDuration.toFixed(1)),
      overallAccuracyPct: parseFloat(acc.toFixed(1)),
      averageRangeStationTimeSec: parseFloat(totalDuration.toFixed(1)),
      coachFeedback: []
    };
    session.coachFeedback = RuleBasedCoach.generateFeedback(session);
    return session;
  }
}
