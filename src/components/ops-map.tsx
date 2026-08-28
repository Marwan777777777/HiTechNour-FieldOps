import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import "leaflet/dist/leaflet.css";

export type MapSite = {
  id: number;
  name: string;
  lat: number;
  lng: number;
  radius_meters: number;
};

export type MapPerson = {
  user_id: string;
  full_name: string;
  lat: number;
  lng: number;
  site_name?: string;
};

type Props = {
  sites?: MapSite[];
  people?: MapPerson[];
  worker?: { lat: number; lng: number } | null;
  pickable?: boolean;
  onPick?: (c: { lat: number; lng: number }) => void;
  className?: string;
};

function token(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function OpsMap({ sites = [], people = [], worker, pickable, onPick, className }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const layerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const onPickRef = useRef(onPick);
  const [ready, setReady] = useState(false);
  onPickRef.current = onPick;

  useEffect(() => {
    if (!el.current) return;
    let cancelled = false;
    let clickHandler: ((e: import("leaflet").LeafletMouseEvent) => void) | null = null;
    void (async () => {
      const L = await import("leaflet");
      if (cancelled || !el.current || mapRef.current) return;
      const map = L.map(el.current, {
        zoomControl: true,
        attributionControl: true,
        scrollWheelZoom: true,
      });
      // OSM is free and needs no key. Carto dark_all now watermarks "API KEY REQUIRED".
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap",
        maxZoom: 19,
      }).addTo(map);
      map.setView([30.0444, 31.2357], 10);
      layerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      setReady(true);
      requestAnimationFrame(() => map.invalidateSize());
      clickHandler = (e) => onPickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng });
      if (pickable) map.on("click", clickHandler);
    })();
    return () => {
      cancelled = true;
      if (clickHandler) mapRef.current?.off("click", clickHandler);
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [pickable]);

  useEffect(() => {
    const map = mapRef.current;
    const layers = layerRef.current;
    if (!map || !layers) return;
    void import("leaflet").then((L) => {
      layers.clearLayers();
      const accent = token("--color-accent", "#c5cdd8");
      const ok = token("--color-ok", "#6ee7b7");
      const muted = token("--color-muted", "#8b97ab");
      const bounds: import("leaflet").LatLngExpression[] = [];

      for (const s of sites) {
        L.circle([s.lat, s.lng], {
          radius: s.radius_meters,
          color: muted,
          weight: 1,
          fillColor: accent,
          fillOpacity: 0.08,
        }).addTo(layers);
        L.circleMarker([s.lat, s.lng], {
          radius: 5,
          color: accent,
          fillColor: accent,
          fillOpacity: 1,
          weight: 1,
        })
          .bindTooltip(s.name)
          .addTo(layers);
        bounds.push([s.lat, s.lng]);
      }

      for (const p of people) {
        L.circleMarker([p.lat, p.lng], {
          radius: 6,
          color: ok,
          fillColor: ok,
          fillOpacity: 1,
          weight: 1,
        })
          .bindTooltip(`${p.full_name}${p.site_name ? ` · ${p.site_name}` : ""}`)
          .addTo(layers);
        bounds.push([p.lat, p.lng]);
      }

      if (worker) {
        L.circleMarker([worker.lat, worker.lng], {
          radius: 7,
          color: accent,
          fillColor: accent,
          fillOpacity: 1,
          weight: 2,
        }).addTo(layers);
        bounds.push([worker.lat, worker.lng]);
      }

      if (bounds.length === 1) map.setView(bounds[0], 14);
      else if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds).pad(0.25));
    });
  }, [ready, sites, people, worker]);

  return <div ref={el} className={cn("ops-map ops-map-osm", className)} />;
}
