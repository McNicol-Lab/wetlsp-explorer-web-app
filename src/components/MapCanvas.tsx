/**
 * MapLibre + deck.gl, wired together imperatively.
 *
 * Uses `MapLibreOverlay` rather than `@deck.gl/mapbox`'s `MapboxOverlay`: the
 * latter targets Mapbox GL JS, and its interleaved path does not drive
 * MapLibre v5's renderer, so its layers silently never draw.
 *
 * deck runs interleaved, so both draw into one WebGL canvas: layers respect the
 * map's depth buffer, and a PNG export is a single `toDataURL`.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import maplibregl, { type Map as MapLibreMap, type LngLatBoundsLike } from 'maplibre-gl';
import { MapLibreOverlay } from '@deck.gl/maplibre';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { basemapStyle, type BasemapId } from '@/lib/basemaps';

export interface MapCanvasHandle {
  map(): MapLibreMap | null;
  fitBounds(bounds: [number, number, number, number], padding?: number): void;
  canvas(): HTMLCanvasElement | null;
  /** Force a redraw so the drawing buffer is populated before an export. */
  repaint(): void;
}

export interface MapCanvasProps {
  basemap: BasemapId;
  dark: boolean;
  layers: Layer[];
  initialBounds?: [number, number, number, number] | null;
  /**
   * What `initialBounds` belong to, e.g. the site id. The map fits the bounds
   * once per key, so switching sites re-frames the new site while pans and
   * zooms within one site are left alone.
   */
  fitKey?: string;
  initialViewState?: { longitude: number; latitude: number; zoom: number };
  interactive?: boolean;
  pitch?: number;
  getTooltip?: (info: PickingInfo) => string | null;
  onClick?: (info: PickingInfo) => void;
  onMapReady?: (map: MapLibreMap) => void;
  children?: ReactNode;
  className?: string;
}

export const MapCanvas = forwardRef<MapCanvasHandle, MapCanvasProps>(function MapCanvas(
  {
    basemap,
    dark,
    layers,
    initialBounds,
    fitKey = '',
    initialViewState,
    interactive = true,
    pitch = 0,
    getTooltip,
    onClick,
    onMapReady,
    children,
    className,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const overlayRef = useRef<MapLibreOverlay | null>(null);
  /** The fitKey last fitted, or null before the first fit on this map. */
  const didFit = useRef<string | null>(null);
  // Bumped whenever a map instance is created, so the fit effect re-runs after
  // a remount (React StrictMode mounts, unmounts and mounts again in dev).
  const [mapEpoch, setMapEpoch] = useState(0);
  const callbacks = useRef({ getTooltip, onClick });
  callbacks.current = { getTooltip, onClick };
  const currentLayers = useRef(layers);
  currentLayers.current = layers;

  useImperativeHandle(ref, () => ({
    map: () => mapRef.current,
    // In interleaved mode this is the basemap canvas, which already holds the
    // deck layers, so one canvas is the whole picture.
    canvas: () => overlayRef.current?.getCanvas() ?? mapRef.current?.getCanvas() ?? null,
    repaint: () => {
      mapRef.current?.triggerRepaint();
      overlayRef.current?.setProps({});
    },
    fitBounds: (bounds, padding = 48) => {
      const map = mapRef.current;
      if (!map) return;
      const [w, s, e, n] = bounds;
      if (![w, s, e, n].every(Number.isFinite)) return;
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ] as LngLatBoundsLike,
        { padding, duration: 600, maxZoom: 17 },
      );
    },
  }));

  // Create the map once; style, layers and bounds are patched in later effects.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    didFit.current = null;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: basemapStyle(basemap, dark),
      center: [initialViewState?.longitude ?? 0, initialViewState?.latitude ?? 20],
      zoom: initialViewState?.zoom ?? 1.4,
      pitch,
      interactive,
      attributionControl: { compact: true },
      // Required so the WebGL canvas can be read back for PNG export.
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
      maxPitch: 75,
    });
    // Bottom-right: every view overlays its own toolbar along the top edge,
    // which would otherwise cover the zoom buttons.
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    const overlay = new MapLibreOverlay({
      interleaved: true,
      pickingRadius: 5,
      layers: [],
      getTooltip: (info) => {
        const text = callbacks.current.getTooltip?.(info);
        if (!text) return null;
        return {
          html: text,
          style: {
            background: 'var(--bg-elevated)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: '10px',
            boxShadow: 'var(--shadow-card)',
            fontSize: '12px',
            padding: '7px 9px',
            lineHeight: '1.45',
          },
        };
      },
    });
    map.addControl(overlay);
    // Interleaved MapLibreOverlay shares the map's drawing buffer, but its
    // native deck gesture handler does not reliably receive MapLibre clicks.
    // Use the map's public event and the overlay's public picking API. Do not
    // also register deck onClick: that could toggle the same pixel twice.
    const onMapClick = (event: maplibregl.MapMouseEvent) => {
      if (!callbacks.current.onClick) return;
      const info = overlay.pickObject({ x: event.point.x, y: event.point.y, radius: 5 });
      callbacks.current.onClick(info ?? {
        color: null, layer: null, index: -1, picked: false,
        x: event.point.x, y: event.point.y, pixelRatio: window.devicePixelRatio,
        coordinate: [event.lngLat.lng, event.lngLat.lat],
      });
    };
    map.on('click', onMapClick);

    mapRef.current = map;
    overlayRef.current = overlay;
    // Coordinate APIs are usable now. Waiting for all remote tiles to load
    // leaves the draw tool inactive while a visible pixel cloud can be panned.
    onMapReady?.(map);
    setMapEpoch((n) => n + 1);

    return () => {
      map.off('click', onMapClick);
      overlay.finalize();
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
      didFit.current = null;
    };
    // Intentionally one-shot: subsequent prop changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // A style replacement removes deck's custom MapLibre layer. Its styledata
    // handler can run while source tiles still load and skip reattachment.
    // Reapply the latest layers once the new style and sources become idle.
    const restoreLayers = () => overlayRef.current?.setProps({ layers: currentLayers.current });
    map.once('idle', restoreLayers);
    map.setStyle(basemapStyle(basemap, dark));
    return () => { map.off('idle', restoreLayers); };
  }, [basemap, dark]);

  useEffect(() => {
    overlayRef.current?.setProps({ layers });
  }, [layers]);

  // Tilt when a view switches to 3D (the Pixel Map skyline) and back.
  useEffect(() => {
    const map = mapRef.current;
    if (map && map.getPitch() !== pitch) map.easeTo({ pitch, duration: 500 });
  }, [pitch]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !initialBounds || didFit.current === fitKey) return;
    const [w, s, e, n] = initialBounds;
    if (![w, s, e, n].every(Number.isFinite) || (w === e && s === n)) return;
    const first = didFit.current === null;
    didFit.current = fitKey;
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ] as LngLatBoundsLike,
      // Instant on first load; a short move when switching sites.
      { padding: 56, duration: first ? 0 : 450, maxZoom: 17, pitch: map.getPitch() },
    );
  }, [initialBounds, fitKey, mapEpoch]);

  return (
    <div className={className ?? 'relative h-full w-full'}>
      {/*
        Sized with h-full rather than `absolute inset-0`: maplibre-gl.css is
        un-layered, so its `.maplibregl-map { position: relative }` outranks
        Tailwind's layered `.absolute` and the container would collapse to 0.
      */}
      <div ref={containerRef} className="h-full w-full overflow-hidden rounded-[13px]" />
      {children}
    </div>
  );
});
