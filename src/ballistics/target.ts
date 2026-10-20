/**
 * UIPM / ISSF 10m Laser Pistol Target Geometry & Optical Sight Ballistics
 *
 * Official ISSF / UIPM 10m Pistol Target Ring Diameters:
 * - Inner 10 (X-ring): 5.0 mm (radius 2.5 mm)
 * - 10 Ring: 11.5 mm (radius 5.75 mm)
 * - 9 Ring:  27.5 mm (radius 13.75 mm)
 * - 8 Ring:  43.5 mm (radius 21.75 mm)
 * - 7 Ring (Black Hit Zone boundary): 59.5 mm (radius 29.75 mm)
 * - 6 Ring:  75.5 mm (radius 37.75 mm)
 * - 5 Ring:  91.5 mm (radius 45.75 mm)
 * - 4 Ring: 107.5 mm (radius 53.75 mm)
 * - 3 Ring: 123.5 mm (radius 61.75 mm)
 * - 2 Ring: 139.5 mm (radius 69.75 mm)
 * - 1 Ring: 155.5 mm (radius 77.75 mm)
 * Each ring width from 1 to 9 is 8.0 mm radially (16.0 mm diameter step).
 */

export class TargetGeometry {
  private distanceMeters: number;
  private hitZoneDiameterMm: number;
  public readonly sightRadiusMm = 320.0; // Standard match laser pistol sight radius (e.g. Pentashot / Ecoaims)

  constructor(distanceMeters: number = 10.0, hitZoneDiameterMm: number = 59.5) {
    this.distanceMeters = distanceMeters;
    this.hitZoneDiameterMm = hitZoneDiameterMm;
  }

  public getHitZoneRadiusMm(): number {
    return this.hitZoneDiameterMm / 2.0; // 29.75 mm
  }

  public getRingRadiusMm(ringNumber: number): number {
    if (ringNumber === 11) return 2.5; // Inner 10 (X-ring)
    if (ringNumber === 10) return 5.75;
    // Rings 9 down to 1 increase by 8.0 mm radius per ring
    return 5.75 + (10 - ringNumber) * 8.0;
  }

  /**
   * Computes exact ISSF/SCATT Decimal Score (0.0 to 10.9) from radial error in mm.
   * Any score >= 7.0 (radialErrorMm <= 29.75mm) is a valid UIPM Laser Run HIT.
   */
  public computeDecimalScore(radialErrorMm: number): number {
    if (radialErrorMm <= 5.75) {
      // Inside 10 ring: 10.0 to 10.9
      const frac = 1.0 - radialErrorMm / 5.75;
      return parseFloat((10.0 + Math.min(0.9, Math.floor(frac * 10) * 0.1)).toFixed(1));
    }
    // Outside 10 ring: each 8.0 mm is 1.0 ring point (0.8 mm per 0.1 point)
    const distFrom10 = radialErrorMm - 5.75;
    const rawScore = 10.0 - distFrom10 / 8.0;
    if (rawScore < 1.0) return 0.0;
    return parseFloat(Math.max(0.0, Math.floor(rawScore * 10) / 10).toFixed(1));
  }

  /**
   * Computes standard shooting clock-face direction (1 to 12 o'clock)
   * where +Y is 12 o'clock (up) and +X is 3 o'clock (right).
   */
  public computeClockDirection(xMm: number, yMm: number): number {
    const angleRad = Math.atan2(xMm, yMm); // 0 rad = +Y (12 o'clock), PI/2 = +X (3 o'clock)
    let deg = (angleRad * 180.0) / Math.PI;
    if (deg < 0) deg += 360.0;
    const hour = Math.round(deg / 30.0) % 12;
    return hour === 0 ? 12 : hour;
  }

  /**
   * Converts angular deviation in degrees (yaw, pitch) plus pistol cant angle (rollDeg)
   * and wrist sight-alignment error into millimeters on the 10m target plane.
   */
  public anglesToTargetMm(
    yawDeg: number,
    pitchDeg: number,
    cantDeg: number = 0,
    frontSightShiftMm: number = 0
  ): { xMm: number; yMm: number; radialErrorMm: number } {
    const yawRad = (yawDeg * Math.PI) / 180.0;
    const pitchRad = (pitchDeg * Math.PI) / 180.0;

    // Base target coordinate at distance D
    let xMm = this.distanceMeters * Math.tan(yawRad) * 1000.0;
    let yMm = this.distanceMeters * Math.tan(pitchRad) * 1000.0;

    // Sight misalignment amplification: 1 mm front sight shift on a 320mm sight radius
    // produces (10,000 / 320) = 31.25 mm shift on target!
    const sightAmplification = (this.distanceMeters * 1000.0) / this.sightRadiusMm;
    xMm += frontSightShiftMm * sightAmplification;

    // Cant Error (倾斜误差): Tilting the pistol shifts point of impact horizontally & drops vertically
    // especially when sights are zeroed above bore axis (~22mm sight height over laser bore)
    const cantRad = (cantDeg * Math.PI) / 180.0;
    const sightHeightOverBoreMm = 22.0;
    xMm += Math.sin(cantRad) * sightHeightOverBoreMm * 1.8;
    yMm -= (1.0 - Math.cos(cantRad)) * sightHeightOverBoreMm * 2.5;

    const radialErrorMm = Math.sqrt(xMm * xMm + yMm * yMm);
    return { xMm, yMm, radialErrorMm };
  }

  public evaluateHit(radialErrorMm: number, multiplier: number = 1.0): boolean {
    return radialErrorMm <= this.getHitZoneRadiusMm() * multiplier;
  }
}
