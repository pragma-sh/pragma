import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

/** Playback / volume state driven by a hidden `<audio>` element. */
export type AudioPlayerControls = {
  audioRef: RefObject<HTMLAudioElement | null>;
  playing: boolean;
  duration: number;
  currentTime: number;
  muted: boolean;
  volume: number;
  seekMax: number;
  togglePlay: () => void;
  toggleMute: () => void;
  seekTo: (next: number) => void;
  setVolumeLevel: (next: number) => void;
  beginSeekPreview: (next: number) => void;
  commitSeek: (next: number) => void;
  onKeyDown: (event: KeyboardEvent) => void;
};

/**
 * Owns the hidden `<audio>` element listeners and transport state for
 * {@link AudioPlayer}. Kept as a hook so the presentational surface stays thin.
 */
// fallow-ignore-next-line complexity -- controller hook for one audio element: state + listeners + transport/keyboard callbacks; each callback is already its own useCallback.
export function useAudioPlayer(): AudioPlayerControls {
  const audioRef = useRef<HTMLAudioElement>(null);
  const seekingRef = useRef(false);
  const volumeBeforeMute = useRef(1);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => {
      if (!seekingRef.current) setCurrentTime(audio.currentTime);
    };
    const onMeta = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setCurrentTime(0);
    };
    const onVolume = () => {
      setMuted(audio.muted || audio.volume === 0);
      setVolume(audio.volume);
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("volumechange", onVolume);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("volumechange", onVolume);
    };
  }, []);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => {
        /* autoplay / decode failures surface as a paused control */
      });
    } else {
      audio.pause();
    }
  }, []);

  const seekTo = useCallback((next: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(next)) return;
    audio.currentTime = next;
    setCurrentTime(next);
  }, []);

  const setVolumeLevel = useCallback((next: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const clamped = Math.min(1, Math.max(0, next));
    audio.volume = clamped;
    audio.muted = clamped === 0;
    if (clamped > 0) volumeBeforeMute.current = clamped;
    setVolume(clamped);
    setMuted(clamped === 0);
  }, []);

  const toggleMute = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.muted || audio.volume === 0) {
      const restore = volumeBeforeMute.current > 0 ? volumeBeforeMute.current : 1;
      audio.muted = false;
      audio.volume = restore;
      setVolume(restore);
      setMuted(false);
    } else {
      volumeBeforeMute.current = audio.volume > 0 ? audio.volume : 1;
      audio.muted = true;
      setMuted(true);
    }
  }, []);

  const beginSeekPreview = useCallback((next: number) => {
    seekingRef.current = true;
    setCurrentTime(next);
  }, []);

  const commitSeek = useCallback(
    (next: number) => {
      seekingRef.current = false;
      seekTo(next);
    },
    [seekTo],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === " " || event.key === "k") {
        event.preventDefault();
        togglePlay();
        return;
      }
      if (event.key === "m") {
        event.preventDefault();
        toggleMute();
        return;
      }
      const audio = audioRef.current;
      if (!audio) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekTo(Math.max(0, audio.currentTime - 5));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekTo(Math.min(duration || audio.duration || 0, audio.currentTime + 5));
      }
    },
    [duration, seekTo, toggleMute, togglePlay],
  );

  return {
    audioRef,
    playing,
    duration,
    currentTime,
    muted,
    volume,
    seekMax: duration > 0 ? duration : 0,
    togglePlay,
    toggleMute,
    seekTo,
    setVolumeLevel,
    beginSeekPreview,
    commitSeek,
    onKeyDown,
  };
}
