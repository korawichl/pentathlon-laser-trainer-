import { CompleteSessionData, SeriesResult } from '../types';

export class RuleBasedCoach {
  /**
   * Deep SCATT & UIPM Biomechanical Diagnostics for a Single Series
   */
  public static diagnoseSeries(series: SeriesResult): string[] {
    const tips: string[] = [];
    const shots = series.shots;
    if (shots.length === 0) return ['ไม่มีข้อมูลการยิงในชุดนี้'];

    // 1. SCATT Trace Length (L - Muzzle Velocity on Target in mm/s)
    if (series.avgTraceLengthMmPerSec > 240) {
      tips.push(
        `📉 SCATT Trace Length สูง (${series.avgTraceLengthMmPerSec} mm/s — เกณฑ์นักกีฬาทีมชาติ < 140 mm/s): ปากกระบอกปืนยังแกว่งเร็วขณะเล็ง แนะนำล็อกข้อมือและข้อศอกให้เป็นชิ้นเดียวกัน (Bone Support) และใช้ปุ่มกลั้นหายใจช่วงจังหวะลั่นไก`
      );
    } else if (series.avgTraceLengthMmPerSec <= 135) {
      tips.push(
        `🎯 SCATT Hold Stability ยอดเยี่ยม (Trace Speed = ${series.avgTraceLengthMmPerSec} mm/s, อยู่ในวงดำ ${series.avgStability7RingPct}%): ความนิ่งของกล้ามเนื้อหัวไหล่เทียบเท่านักกีฬาระดับนานาชาติ`
      );
    }

    // 2. SCATT Trigger Pull Error (Distance between pre-shot hold center and impact)
    if (series.avgPullErrorMm > 14.0) {
      const mostCommonClock = shots[0]?.scatt.pullDirectionClock || 6;
      tips.push(
        `⚠️ Trigger Pull Displacement สูง (${series.avgPullErrorMm} mm ไปทางทิศ ${mostCommonClock} นาฬิกา): ช่วง -300ms ก่อนลั่นไกศูนย์เล็งอยู่นิ่งแล้ว แต่ในจังหวะปลดเซียร์ (Sear Break) นิ้วชี้หรือข้อมือออกแรงกระตุกทำให้ปากกระบอกสะบัดออกจากจุดเล็ง`
      );
    }

    // 3. Pistol Cant Angle (การเอียงปืนซ้าย/ขวา)
    const highCantShots = shots.filter(s => Math.abs(s.scatt.cantAngleAtShotDeg) > 2.2);
    if (highCantShots.length > 0) {
      const avgCant =
        highCantShots.reduce((acc, s) => acc + s.scatt.cantAngleAtShotDeg, 0) / highCantShots.length;
      const side = avgCant > 0 ? 'ขวา' : 'ซ้าย';
      tips.push(
        `📐 ตรวจพบการเอียงระนาบปืน (Cant Angle เฉลี่ย ${avgCant.toFixed(1)}° ไปทาง${side} จำนวน ${highCantShots.length} นัด): เมื่อเอียงปืน ศูนย์หน้า-หลังจะไม่อยู่ในแนวตั้งฉาก ทำให้กระสุนกินออกข้างและตกต่ำ แนะนำสังเกตระดับบ่าศูนย์หลังให้ขนานพื้นเสมอ`
      );
    }

    // 4. Dispersion Shape (Vertical vs Horizontal)
    if (shots.length >= 3) {
      if (series.verticalDispersionMm > series.horizontalDispersionMm * 1.65 && series.verticalDispersionMm > 14) {
        tips.push(
          `↕️ กลุ่มกระสุนกระจายตัวในแนวดิ่ง (Vertical SD = ${series.verticalDispersionMm}mm > Horizontal = ${series.horizontalDispersionMm}mm): เกิดจากจังหวะการหายใจที่ยังไม่นิ่ง หรือการยก-ลดระดับหัวไหล่แต่ละนัดไม่เท่ากัน`
        );
      } else if (
        series.horizontalDispersionMm > series.verticalDispersionMm * 1.65 &&
        series.horizontalDispersionMm > 14
      ) {
        tips.push(
          `↔️ กลุ่มกระสุนกระจายตัวในแนวราบ (Horizontal SD = ${series.horizontalDispersionMm}mm): เกิดจากการวางตำแหน่งข้อนิ้วชี้บนไกปืนลึกหรือตื้นเกินไป ทำให้เกิดแรงผลักด้านข้างขณะบีบไก`
        );
      }
    }

    // 5. First-Shot Table Raise Acquisition
    if (series.firstShotDurationSec > 3.4) {
      tips.push(
        `⏱️ First-Shot Acquisition ช้า (${series.firstShotDurationSec}s — เป้าหมาย UIPM < 2.6s): จังหวะยกปืนขึ้นจากโต๊ะยังมีช่วงชะงักเพื่อหาศูนย์หน้า แนะนำฝึกยกแขนขึ้นเหนือเป้าเล็กน้อยแล้วลดปืนลงเข้าหาจุดเล็งพร้อมดึงไกขั้นที่ 1 (Take-up) ทันที`
      );
    } else if (series.firstShotDurationSec > 0 && series.firstShotDurationSec <= 2.6 && shots[0]?.isHit) {
      tips.push(
        `⚡ First-Shot Table Raise คมกริบ (${series.firstShotDurationSec}s เข้าเป้า): ยกปืนจากโต๊ะขึ้นจับศูนย์และลั่นไกนัดแรกได้รวดเร็วตามมาตรฐาน UIPM`
      );
    }

    // 6. Follow-through & Deltoid Fatigue
    const overHeldShots = shots.filter(s => s.deltoidFatiguePct > 55);
    if (overHeldShots.length > 0) {
      tips.push(
        `💪 กล้ามเนื้อหัวไหล่ล้าจากการเล็งแช่นาน (Deltoid Fatigue > 55%): ห้ามฝืนยิงเมื่อยกปืนค้างเกิน 8-10 วินาที เพราะจะเกิดอาการสั่นระดับ 9Hz แนะนำลดปืนลงแตะโต๊ะสั้นๆ เพื่อรีเซ็ตกล้ามเนื้อ`
      );
    }

    return tips;
  }

  public static generateFeedback(session: CompleteSessionData): string[] {
    if (session.series.length === 0) return ['ไม่มีข้อมูลเซสชัน'];
    return this.diagnoseSeries(session.series[session.series.length - 1]);
  }
}
