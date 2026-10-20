import { DataSourceType } from '../types';

export class HeartRateTelemetry {
  private currentBpm: number = 72;
  private source: DataSourceType = 'SIMULATED_MODEL';
  private bluetoothDevice: BluetoothDevice | null = null;
  private hrCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private listeners: ((bpm: number, source: DataSourceType) => void)[] = [];

  // Physiological simulation state (used ONLY when no real BLE sensor is present)
  private simTargetBpm: number = 75;
  private simCurrentBpm: number = 75;

  public subscribe(cb: (bpm: number, source: DataSourceType) => void) {
    this.listeners.push(cb);
    cb(this.getBpm(), this.getSource());
  }

  public getBpm(): number {
    return Math.round(this.currentBpm);
  }

  public getSource(): DataSourceType {
    return this.source;
  }

  public setManualBpm(bpm: number) {
    this.currentBpm = bpm;
    this.source = 'MANUAL_ENTRY';
    this.notify();
  }

  public setSimulatedTarget(targetBpm: number) {
    if (this.source === 'HARDWARE_BLE') return; // Do not override real hardware
    this.source = 'SIMULATED_MODEL';
    this.simTargetBpm = targetBpm;
  }

  public updateSimulationTick(dtSec: number) {
    if (this.source !== 'SIMULATED_MODEL') return;
    // Exponential approach towards target BPM (half-life ~ 15s)
    const tau = 15.0;
    this.simCurrentBpm += (this.simTargetBpm - this.simCurrentBpm) * (1 - Math.exp(-dtSec / tau));
    this.currentBpm = this.simCurrentBpm;
    this.notify();
  }

  public isBluetoothSupported(): boolean {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  public async connectBleSensor(): Promise<boolean> {
    if (!this.isBluetoothSupported()) {
      throw new Error('Web Bluetooth API is not supported on this device/browser.');
    }

    try {
      this.bluetoothDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: ['heart_rate'] }]
      });

      if (!this.bluetoothDevice.gatt) {
        throw new Error('Device does not support GATT server.');
      }

      const server = await this.bluetoothDevice.gatt.connect();
      const service = await server.getPrimaryService('heart_rate');
      this.hrCharacteristic = await service.getCharacteristic('heart_rate_measurement');

      await this.hrCharacteristic.startNotifications();
      this.hrCharacteristic.addEventListener('characteristicvaluechanged', (e: Event) => {
        this.parseHeartRateMeasurement(e);
      });

      this.source = 'HARDWARE_BLE';
      this.notify();
      return true;
    } catch (err) {
      console.warn('BLE Heart Rate connection cancelled or failed:', err);
      return false;
    }
  }

  public disconnectBle() {
    if (this.bluetoothDevice && this.bluetoothDevice.gatt?.connected) {
      this.bluetoothDevice.gatt.disconnect();
    }
    this.bluetoothDevice = null;
    this.hrCharacteristic = null;
    this.source = 'SIMULATED_MODEL';
    this.notify();
  }

  private parseHeartRateMeasurement(event: Event) {
    const target = event.target as unknown as { value: DataView };
    const value = target.value;
    if (!value) return;

    const flags = value.getUint8(0);
    const rate16Bits = flags & 0x1;
    let bpm = 0;
    if (rate16Bits) {
      bpm = value.getUint16(1, true); // 16-bit HR
    } else {
      bpm = value.getUint8(1); // 8-bit HR
    }

    if (bpm > 30 && bpm < 240) {
      this.currentBpm = bpm;
      this.source = 'HARDWARE_BLE';
      this.notify();
    }
  }

  private notify() {
    this.listeners.forEach(cb => cb(this.getBpm(), this.getSource()));
  }
}
