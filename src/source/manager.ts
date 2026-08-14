import type { FrameSource } from '../cv/engine';
import { SyntheticSource } from './synthetic';

export type SourceKind = 'none' | 'synthetic' | 'file' | 'url' | 'camera' | 'screen';

/**
 * Owns whichever feed is currently live and presents a single FrameSource to
 * the engine. Swapping sources never restarts the engine — it just changes
 * what `drawable` points at.
 */
export class SourceManager implements FrameSource {
  readonly synthetic = new SyntheticSource();
  readonly video = document.createElement('video');
  // Starts empty on purpose. Real footage is the product; the generated scene is
  // a fallback you opt into, not the thing the app is about.
  kind: SourceKind = 'none';
  label = 'No feed';

  private stream: MediaStream | null = null;
  private objectUrl: string | null = null;
  private lastFrame = performance.now();
  private listeners = new Set<() => void>();
  private loopListeners = new Set<() => void>();
  private lastTime = 0;
  /** Set while the pre-race check scrubs the clip, so its seeks aren't read as loops. */
  seeking = false;

  constructor() {
    this.video.muted = true;
    this.video.loop = true;
    this.video.playsInline = true;
    this.video.crossOrigin = 'anonymous';
    this.video.preload = 'auto';

    this.video.addEventListener('timeupdate', () => {
      const t = this.video.currentTime;
      if (!this.seeking && t < this.lastTime - 0.5) {
        for (const fn of this.loopListeners) fn();
      }
      this.lastTime = t;
    });
  }

  /** Fires when a looping clip jumps back to the start. */
  onLoopRestart(fn: () => void) {
    this.loopListeners.add(fn);
    return () => this.loopListeners.delete(fn);
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  get usingSynthetic() {
    return this.kind === 'synthetic';
  }

  get drawable(): CanvasImageSource | null {
    if (this.kind === 'none') return null;
    if (this.kind === 'synthetic') return this.synthetic.canvas;
    return this.video.readyState >= 2 ? this.video : null;
  }

  get width() {
    if (this.kind === 'none') return 0;
    return this.kind === 'synthetic' ? this.synthetic.width : this.video.videoWidth;
  }

  get height() {
    if (this.kind === 'none') return 0;
    return this.kind === 'synthetic' ? this.synthetic.height : this.video.videoHeight;
  }

  get ready() {
    if (this.kind === 'none') return false;
    return this.kind === 'synthetic' ? true : this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  /** Identifies the current feed, so calibration can be tied to it. */
  get signature() {
    if (this.kind === 'none') return '';
    if (this.kind === 'synthetic') return 'synthetic';
    return `${this.kind}:${this.label}:${this.width}x${this.height}:${this.videoDuration.toFixed(1)}`;
  }

  get videoDuration() {
    return Number.isFinite(this.video.duration) ? this.video.duration : 0;
  }

  /** True when the feed can be scrubbed, which auto-calibration needs. */
  get seekable() {
    return (
      (this.kind === 'file' || this.kind === 'url') &&
      Number.isFinite(this.video.duration) &&
      this.video.duration > 0
    );
  }

  /** The element the UI should show. */
  get displayElement(): HTMLElement | null {
    if (this.kind === 'none') return null;
    return this.kind === 'synthetic' ? this.synthetic.canvas : this.video;
  }

  /**
   * Frame-arrival notification for video-backed feeds. Covers files, streams
   * and live camera alike — anything rendering through the <video> element.
   */
  onNextFrame(cb: (presentedAt: number) => void): (() => void) | undefined {
    if (this.kind === 'none' || this.kind === 'synthetic') return undefined;
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?(c: (now: number, meta: { presentationTime: number }) => void): number;
      cancelVideoFrameCallback?(h: number): void;
    };
    if (typeof v.requestVideoFrameCallback !== 'function') return undefined;
    const handle = v.requestVideoFrameCallback((now, meta) => {
      cb(meta?.presentationTime ?? now);
    });
    return () => v.cancelVideoFrameCallback?.(handle);
  }

  /** Advance the synthetic scene. No-op for real feeds, which advance themselves. */
  pump() {
    const now = performance.now();
    const dt = Math.min(64, now - this.lastFrame);
    this.lastFrame = now;
    if (this.kind === 'synthetic') this.synthetic.update(dt);
  }

  private teardown() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.video.srcObject = null;
    this.video.removeAttribute('src');
    this.video.load();
  }

  useNone() {
    this.teardown();
    this.kind = 'none';
    this.label = 'No feed';
    this.emit();
  }

  useSynthetic() {
    this.teardown();
    this.kind = 'synthetic';
    this.label = 'Generated scene';
    this.emit();
  }

  async useFile(file: File) {
    this.teardown();
    this.objectUrl = URL.createObjectURL(file);
    this.kind = 'file';
    this.label = file.name;
    this.video.loop = true;
    this.video.src = this.objectUrl;
    this.emit();
    await this.waitForMetadata();
    await this.play();
  }

  async useUrl(url: string) {
    this.teardown();
    this.kind = 'url';
    this.label = url.split('/').pop() || url;
    this.video.loop = true;
    this.video.src = url;
    this.emit();
    await this.waitForMetadata();
    await this.play();
  }

  /** Resolves once duration and dimensions are known, or rejects if the clip will not decode. */
  private waitForMetadata(timeoutMs = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.video.readyState >= 1 && this.video.videoWidth > 0) return resolve();
      let settled = false;
      const ok = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('This file could not be decoded. Try MP4 (H.264) or WebM.'));
      };
      const cleanup = () => {
        this.video.removeEventListener('loadedmetadata', ok);
        this.video.removeEventListener('error', fail);
        clearTimeout(timer);
      };
      const timer = setTimeout(fail, timeoutMs);
      this.video.addEventListener('loadedmetadata', ok);
      this.video.addEventListener('error', fail);
    });
  }

  async useCamera() {
    this.teardown();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'environment' },
      audio: false,
    });
    this.kind = 'camera';
    this.label = 'Live camera';
    await this.attachStream();
  }

  /**
   * Capture a window, tab or screen as the feed.
   *
   * This is the practical route to a genuinely live race: point it at whatever
   * is carrying the broadcast — a stream in another tab, a video wall, a
   * timing screen — and the pipeline treats it exactly like a trackside camera.
   * No ingest server, no transcoding, no RTSP plumbing.
   */
  async useScreen() {
    this.teardown();
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: false,
    });
    this.kind = 'screen';
    this.label = 'Screen capture';
    // The user can stop sharing from the browser's own bar; handle that.
    for (const t of this.stream.getVideoTracks()) {
      t.addEventListener('ended', () => {
        if (this.kind === 'screen') this.useNone();
      });
    }
    await this.attachStream();
  }

  private async attachStream() {
    this.video.loop = false;
    this.video.srcObject = this.stream;
    this.emit();
    await this.play();
  }

  /** True for feeds that never end and cannot be scrubbed. */
  get isLive() {
    return this.kind === 'camera' || this.kind === 'screen';
  }

  private async play() {
    try {
      await this.video.play();
    } catch {
      // Autoplay can be blocked until a gesture; the play control handles it.
    }
  }

  togglePlay() {
    if (this.kind === 'none') return false;
    if (this.kind === 'synthetic') {
      this.synthetic.speed = this.synthetic.speed === 0 ? 1 : 0;
      return this.synthetic.speed !== 0;
    }
    if (this.video.paused) {
      void this.video.play();
      return true;
    }
    this.video.pause();
    return false;
  }

  get playing() {
    if (this.kind === 'none') return false;
    return this.kind === 'synthetic' ? this.synthetic.speed !== 0 : !this.video.paused;
  }
}
