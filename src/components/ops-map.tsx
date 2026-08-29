import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

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
  site_name?: string | null;
  on_site?: boolean;
  created_at?: string;
  punch_type?: string;
};

type Props = {
  sites?: MapSite[];
  people?: MapPerson[];
  worker?: { lat: number; lng: number } | null;
  pickable?: boolean;
  onPick?: (c: { lat: number; lng: number }) => void;
  className?: string;
  legend?: boolean;
};

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "\u0026amp;";
    if (ch === "<") return "\u0026lt;";
    if (ch === ">") return "\u0026gt;";
    if (ch === '"') return "\u0026quot;";
    return "\u0026#39;";
  });
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

function formatSeen(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
}

export function OpsMap({
  sites = [],
  people = [],
  worker,
  pickable,
  onPick,
  className,
  legend,
}: Props) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const layerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const onPickRef = useRef(onPick);
  const userMoved = useRef(false);
  const [ready, setReady] = useState(false);
  onPickRef.current = onPick;

  useEffect(() => {
    if (!el.current) return;
    let cancelled = false;
    let clickHandler: ((e: import("leaflet").LeafletMouseEvent) => void) | null = null;
    let dragHandler: (() => void) | null = null;
    void (async () => {
      await import("leaflet/dist/leaflet.css");
      const L = await import("leaflet");
      if (cancelled || !el.current || mapRef.current) return;
      const map = L.map(el.current, {
        zoomControl: true,
        attributionControl: true,
        scrollWheelZoom: true,
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap",
        maxZoom: 19,
      }).addTo(map);
      map.setView([30.0444, 31.2357], 10);
      layerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      dragHandler = () => {
        userMoved.current = true;
      };
      map.on("dragstart", dragHandler);
      map.on("zoomstart", dragHandler);
      setReady(true);
      requestAnimationFrame(() => map.invalidateSize());
      clickHandler = (e) => onPickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng });
      if (pickable) map.on("click", clickHandler);
    })();
    return () => {
      cancelled = true;
      if (clickHandler) mapRef.current?.off("click", clickHandler);
      if (dragHandler) {
        mapRef.current?.off("dragstart", dragHandler);
        mapRef.current?.off("zoomstart", dragHandler);
      }
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
      userMoved.current = false;
    };
  }, [pickable]);

  useEffect(() => {
    const map = mapRef.current;
    const layers = layerRef.current;
    if (!map || !layers) return;
    void import("leaflet").then((L) => {
      layers.clearLayers();
      const bounds: import("leaflet").LatLngExpression[] = [];

      for (const s of sites) {
        L.circle([s.lat, s.lng], {
          radius: s.radius_meters,
          color: "#54d7e7",
          weight: 2,
          fillColor: "#54d7e7",
          fillOpacity: 0.16,
        }).addTo(layers);
        const icon = L.divIcon({
          className: "htn-site-marker",
          html: `<div class="htn-site-dot"></div><span class="htn-site-label">${escapeHtml(s.name)}</span>`,
          iconSize: [180, 28],
          iconAnchor: [10, 14],
        });
        L.marker([s.lat, s.lng], { icon, zIndexOffset: 200 })
          .bindTooltip(`${s.name} · ${s.radius_meters}m`, { direction: "top" })
          .addTo(layers);
        bounds.push([s.lat, s.lng]);
      }

      for (const p of people) {
        const on = Boolean(p.on_site);
        const seen = formatSeen(p.created_at);
        const icon = L.divIcon({
          className: "htn-worker-marker",
          html: `<div class="htn-worker-dot ${on ? "is-on" : "is-last"}">${escapeHtml(initials(p.full_name))}</div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        });
        const tip = [p.full_name, on ? "On site" : "Last location", p.site_name, seen]
          .filter(Boolean)
          .join(" · ");
        L.marker([p.lat, p.lng], { icon, zIndexOffset: on ? 500 : 300 })
          .bindTooltip(tip, { direction: "top" })
          .addTo(layers);
        bounds.push([p.lat, p.lng]);
      }

      if (worker) {
        L.circleMarker([worker.lat, worker.lng], {
          radius: 8,
          color: "#e8edf5",
          fillColor: "#4a8ff0",
          fillOpacity: 1,
          weight: 2,
        }).addTo(layers);
        bounds.push([worker.lat, worker.lng]);
      }

      if (bounds.length && !userMoved.current) {
        if (bounds.length === 1) map.setView(bounds[0], pickable ? 16 : 13);
        else map.fitBounds(L.latLngBounds(bounds).pad(0.28));
      }
    });
  }, [ready, sites, people, worker, pickable]);

  const onSite = people.filter((p) => p.on_site).length;

  return (
    <div className={cn("ops-map ops-map-osm relative", className)}>
      <div ref={el} className="absolute inset-0" />
      {legend ? (
        <div className="htn-map-legend">
          <span>
            <i className="htn-leg-site" /> {sites.length} sites
          </span>
          <span>
            <i className="htn-leg-on" /> {onSite} on site
          </span>
          <span>
            <i className="htn-leg-last" /> {people.length} last locations
          </span>
        </div>
      ) : null}
    </div>
  );
}
